// cli-table3 wrapper for status tables, doctor output, and the
// post-install summary. The Table constructor is exposed for test
// injection so unit tests can verify rows/columns without a real TTY.

import Table from 'cli-table3'
import { color } from './theme.js'

type TableCtor = new (opts: Table.TableOptions) => Table.Table

let TableCtor: TableCtor = Table as unknown as TableCtor

export function setTableImpl(ctor: TableCtor): void {
  TableCtor = ctor
}

export function resetTableImpl(): void {
  TableCtor = Table as unknown as TableCtor
}

export interface TableSpec {
  head: readonly string[]
  rows: readonly (readonly string[])[]
  colWidths?: readonly number[]
  wordWrap?: boolean
}

export function renderTable(spec: TableSpec): string {
  const table = new TableCtor({
    head: spec.head.map((h) => color('bold', h)),
    style: { head: [], border: [] },
    wordWrap: spec.wordWrap ?? true,
    ...(spec.colWidths !== undefined ? { colWidths: [...spec.colWidths] } : {}),
  })
  for (const row of spec.rows) {
    table.push([...row])
  }
  return table.toString()
}

export function statusRow(label: string, ok: boolean, detail?: string): string[] {
  return [label, ok ? color('success', 'OK') : color('error', 'HIBA'), detail ?? '']
}