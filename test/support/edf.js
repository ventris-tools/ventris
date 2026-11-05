const pad = (value, width, fill = ' ') => String(value).padEnd(width, fill);

// Builds an EDF file from [{ label, samples, physical, digital, unit, value, tal }]. A tal
// function gives the text of an annotation channel for each record.
export function buildEdf(
  signals,
  {
    records = 2,
    seconds = 1,
    reserved = '',
    declared = records,
    subject = 'X X X X',
    recording = 'Startdate X X X X',
    date = '01.01.26',
    time = '00.00.00',
    fill = ' ',
  } = {},
) {
  const n = signals.length;
  const column = (width, pick) => signals.map((s) => pad(pick(s), width, fill)).join('');
  const header =
    pad('0', 8, fill) +
    pad(subject, 80) +
    pad(recording, 80) +
    pad(date, 8) +
    pad(time, 8) +
    pad(256 * (n + 1), 8, fill) +
    pad(reserved, 44) +
    pad(declared, 8, fill) +
    pad(seconds, 8, fill) +
    pad(n, 4, fill) +
    column(16, (s) => s.label) +
    column(80, () => '') +
    column(8, (s) => s.unit ?? 'uV') +
    column(8, (s) => s.physical?.[0] ?? -100) +
    column(8, (s) => s.physical?.[1] ?? 100) +
    column(8, (s) => s.digital?.[0] ?? -1000) +
    column(8, (s) => s.digital?.[1] ?? 1000) +
    column(80, (s) => s.prefilter ?? '') +
    column(8, (s) => s.samples) +
    column(32, () => '');

  const recordBytes = 2 * signals.reduce((sum, s) => sum + s.samples, 0);
  const buffer = new ArrayBuffer(header.length + records * recordBytes);
  const bytes = new Uint8Array(buffer);
  bytes.set(new TextEncoder().encode(header));
  const view = new DataView(buffer);
  let at = header.length;
  for (let record = 0; record < records; record += 1) {
    signals.forEach((signal, channel) => {
      if (signal.tal) {
        bytes.set(new TextEncoder().encode(signal.tal(record)), at);
        at += 2 * signal.samples;
        return;
      }
      for (let i = 0; i < signal.samples; i += 1) {
        const value = signal.value ? signal.value(record, i, channel) : i;
        view.setInt16(at, value, true);
        at += 2;
      }
    });
  }
  return buffer;
}
