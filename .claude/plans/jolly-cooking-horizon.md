# Plan: Cycle 17 — `keychain-retrieve-swallows-locked-keychain` fix (high severity)

## Context

A `docs/needs-to-be-fix/keychain-store-insecure-acl.md` (amit a Cycle 16-ban bővítettünk, `28a62ab`) "Path to a real fix" szakasza dokumentálja a függőségi láncot: a `-A` → `-T, SECURITY` swap csak azután végezhető el, ha `keychain-retrieve-swallows-locked-keychain.md` (high severity) zárva van. Ellenkező esetben a kulcstartó promptját a retrieve lenyeli null-ként, és `vault.ts:44-49` csendben új master key-t generál `-U`-val felülírva a régit → teljes vault adatvesztés.

A fix célja, hogy a `keychainRetrieve` a valódi "nincs kulcs" (exit 44) és a "van kulcs, de elérhetetlen" (locked / non-44 throw / ENOENT) állapotokat megkülönböztesse, és utóbbit dobja, ne nyelje le. A `getMasterKey` soha ne generáljon új master key-t, ha a vault már tárol titkokat.

A `keychainRetrieve` jelenlegi `bare catch { return null }` a két állapotot összemossa; a javítás típus-szinten nem szélesíti a signature-t (`string | null` marad), csak a futásidejű szemantikát tisztázza.

## Érintett fájlok

| Fájl | Változás |
|---|---|
| `src/web/keychain.ts` | `KeychainUnavailableError` class hozzáadása; `keychainRetrieve` catch szétválogatása (exit 44 → null, egyéb → throw) |
| `src/web/vault.ts` | `getMasterKey` kiegészítése entries-exist guarddal (ha `store/vault.json` már van titok, soha ne generáljon új master key-t) |
| `src/__tests__/keychain.test.ts` | 3 teszt frissítése (locked throw, ENOENT throw, pinning deviation test split) |
| `src/__tests__/vault.test.ts` | `state.keychainRetrieveThrows` mock-flag aktiválása (1-2 sor); 2 új teszt: (a) `getMasterKey` nem generál új kulcsot ha a vault nem üres, (b) first-run edge case (üres vault + locked keychain = továbbra is mint) |
| `docs/needs-to-be-fix/INDEX.md` | Sor frissítése: `keychain-retrieve-swallows-locked-keychain` → `Resolved: 2026-08-17 <sha>` |
| `docs/needs-to-be-fix/keychain-store-insecure-acl.md` | "Path to a real fix" szakasz frissítése: step 1 (keychain-retrieve) most kész, fennmaradó a step 2 (`-T, SECURITY` swap) |

## Változás részletezése

### 1. `src/web/keychain.ts`

```ts
// Új export, a constants (4-6) és az első function (8) közé:
export class KeychainUnavailableError extends Error {}

// A keychainRetrieve catch szétválogatása:
export function keychainRetrieve(): string | null {
  try {
    const out = execFileSync(SECURITY, [
      'find-generic-password',
      '-s', SERVICE,
      '-a', ACCOUNT,
      '-w',
    ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return out.trim() || null
  } catch (err) {
    // Exit 44 == item genuinely absent. Anything else (locked keychain,
    // ENOENT on non-darwin, errSecInteractionNotAllowed, etc.) is a
    // real failure the caller must surface -- not silently re-key.
    if (isExecError(err) && err.status === 44) return null
    throw new KeychainUnavailableError(err instanceof Error ? err.message : String(err))
  }
}

// Inline typeguard (project rule: no `as`, real typeguard with unknown in):
const isExecError = (e: unknown): e is { status?: number; code?: string } =>
  e instanceof Error || (typeof e === 'object' && e !== null)
```

### 2. `src/web/vault.ts`

A `getMasterKey` L44-55 szakasz kiegészítése egy entries-exist guarddal közvetlenül a `randomBytes(64)` hívás ELŐTT:

```ts
const existing = keychainRetrieve()
if (existing) return Buffer.from(existing, 'base64')

// Defense-in-depth: if the vault already holds secrets and the keychain
// can't read the master key, NEVER mint a replacement. A locked keychain
// returning null is the dominant symptom, but the underlying principle
// is "an existing vault must not be silently re-keyed". vault.ts:30-63
// never reaches here when isKeychainAvailable() is false (the function
// falls through to the file-key branch at L58).
if (readVault().entries.length > 0) {
  throw new KeychainUnavailableError(
    'Vault already contains secrets but the macOS Keychain master key is unreachable. ' +
    'Refusing to mint a replacement to avoid destroying the vault. ' +
    'Unlock the login keychain or restore the master key manually.'
  )
}

const newKey = randomBytes(64).toString('base64')
// ... a maradék változatlan
```

A `keychainRetrieve` throw-ját nem kell külön elkapni — a `getMasterKey`-on belüli `try` nincs, így a throw természetesen propagálódik `encrypt`/`decrypt`-be, onnan a HTTP route-ok try/catch-ébe (`web.ts:219-222` → 500). Ez a kívánt "loud failure" viselkedés.

A `readVault` (`vault.ts:93-96`) már visszaad `{ entries: [] }`-t parse-hiba esetén, tehát az új guard nem töri el a first-run ágat.

### 3. `src/__tests__/keychain.test.ts` — 3 teszt frissítése

**(a) A `returns null when /usr/bin/security is missing` teszt (L242-250) invertálása:**
ENOENT throw nem exit 44 → `KeychainUnavailableError`-t dob.

```ts
it('throws KeychainUnavailableError when /usr/bin/security is missing (non-darwin host)', () => {
  mocks.platform.mockReturnValue('linux')
  mocks.execFileSync.mockImplementation(() => {
    throw Object.assign(new Error('spawnSync /usr/bin/security ENOENT'), { code: 'ENOENT' })
  })
  expect(() => keychainRetrieve()).toThrow(KeychainUnavailableError)
})
```

**(b) A `returns null when security exits non-zero (item not found)` teszt (L233-240) NE változzon:**
Ez a status=44 eset, ami marad `null` (genuine absence).

**(c) A pinning deviation `reports a LOCKED keychain identically to a MISSING item (both null)` (L316-332) szétválasztása:**
A status-36 throw-t vár, a status-44 null marad. A `describe` block kommentjét frissítjük, hogy már ne "pinning"-ként, hanem a fixált viselkedésként hivatkozzon.

```ts
// docs/needs-to-be-fix/keychain-retrieve-swallows-locked-keychain.md (resolved)
it('throws KeychainUnavailableError on a locked keychain (status 36) but stays null for missing items (status 44)', () => {
  const locked = Object.assign(new Error('User interaction is not allowed.'), { status: 36 })
  mocks.execFileSync.mockImplementation(() => { throw locked })
  expect(() => keychainRetrieve()).toThrow(KeychainUnavailableError)

  mocks.execFileSync.mockReset()
  mocks.execFileSync.mockImplementation(() => {
    throw Object.assign(new Error('The specified item could not be found in the keychain.'), { status: 44 })
  })
  expect(keychainRetrieve()).toBeNull()
})
```

**(d) A `-A` pinning test (L300-314) változatlan marad** — a `-A` → `-T, SECURITY` swap külön MD-cycle feladata. A kommentben már dokumentálva van a függőség.

### 4. `src/__tests__/vault.test.ts` — új teszt

A mock a `state.keychainRetrieveThrows` flaget már deklarálja (L77), sosem használta senki. Most élesítjük:

```ts
it('does NOT mint a new master key when keychainRetrieve throws AND vault has entries', () => {
  state.keychainRetrieveThrows = true
  state.keychainRetrieveReturn = null  // ignored when throws=true
  state.vaultEntries = [{ id: 'x', label: 'l', encrypted: 'e', createdAt: 't', updatedAt: 't' }]
  expect(() => getMasterKey()).toThrow(KeychainUnavailableError)
  // No new randomBytes write to keychain should have happened.
  expect(mocks.keychainStore).not.toHaveBeenCalled()
})

it('mints a new master key when keychainRetrieve throws AND vault is empty', () => {
  // First-run case: empty vault + locked keychain is the one edge case
  // where re-keying is unavoidable. The MD documents this; the test
  // pins that the behavior matches the MD's "worth pairing with" note.
  state.keychainRetrieveThrows = true
  state.keychainRetrieveReturn = null
  state.vaultEntries = []
  expect(() => getMasterKey()).not.toThrow()
  expect(mocks.keychainStore).toHaveBeenCalled()
})
```

(A második teszt a "first-run with empty vault" edge case-t pin-eli, ami a javítás után is szükséges — különben a lockolt keychain első indításkor is megakadályozná a vault setup-ot. A MD kiemeli, hogy ez a "worth pairing with" guard csak az entries-exist esetre véd.)

## Végrehajtás

A `test/baseline` branch-ből indul (HEAD = `28a62ab`), oda megy vissza.

A terv **2 commit**-ból áll (ciklikus logika mentén):

1. `fix(keychain): surface locked keychain as actionable error, refuse re-key`
   - Mind az 5 fájl változása (keychain.ts, vault.ts, keychain.test.ts, vault.test.ts + a mock-flag aktiválás)
   - 1 db commit, mert az 5 fájl szervesen összetartozik (a fix nem életképes a tesztek inverziója nélkül, és fordítva)
   
2. `docs(needs-to-be-fix): mark keychain-retrieve resolved, unlock -A fix path`
   - INDEX.md: `keychain-retrieve-swallows-locked-keychain` sor `—` → `Resolved: <sha>`
   - `keychain-store-insecure-acl.md`: "Path to a real fix" szakasz: step 1 (keychain-retrieve) most kész, fennmarad step 2 (`-T, SECURITY` swap)

A `-A` → `-T, SECURITY` swap NEM történik most — az egy külön cycle feladata lesz, amikor a mostani fix már a CI-n is bizonyított.

## Verifikáció

- `bun --bun vitest run src/__tests__/keychain.test.ts` — legalább az új throw-ok zöldek, a `-A` pinning test továbbra is pin-elve (zöld)
- `bun --bun vitest run src/__tests__/vault.test.ts` — az új entries-exist tesztek zöldek
- `bun --bun vitest run` (teljes suite) — 11077/11077 + coverage gap lista nem nő (a fix nem töröl kódot, csak szétválogat)
- `bunx tsc --noEmit` — 1701 baseline marad
- INDEX.md: `keychain-retrieve-swallows-locked-keychain` sor frissítve
- `keychain-store-insecure-acl.md`: "Path to a real fix" frissítve

## Ami NEM történik

- A `-A` → `-T, SECURITY` swap (külön MD cycle)
- A `vault-readvault-missing-entries-fatal` MD (független, `readVault` parse-hibáját kezeli, nem a keychain-t)
- Push (user szabálya)

## Nyitott döntések (usernek)

**Eldöntve (user):** A `vault.test.ts` mock setup (1-2 sor, a `state.keychainRetrieveThrows` flag tényleges aktiválása) ugyanabba a fix commit-ba kerül. A fix commit végül 5 fájlt érint (keychain.ts, vault.ts, keychain.test.ts, vault.test.ts + a docs commit külön). Az atomic fix előnye fontosabb, mint a commit méret.