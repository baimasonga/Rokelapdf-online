/** RFC 4180 CSV, with spreadsheet formula injection disabled for every cell. */
export function csvText(rows: readonly (readonly unknown[])[]): string {
  return (
    rows
      .map((row) =>
        row
          .map((value) => {
            let s = value == null ? '' : String(value);
            if (/^[\s]*[=+@-]/.test(s) || /^[\t\r]/.test(s)) s = `'${s}`;
            return `"${s.replace(/"/g, '""')}"`;
          })
          .join(','),
      )
      .join('\r\n') + '\r\n'
  );
}

export function downloadCsv(name: string, rows: readonly (readonly unknown[])[]) {
  const url = URL.createObjectURL(new Blob(['\uFEFF', csvText(rows)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
