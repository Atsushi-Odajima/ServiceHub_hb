/** RFC 5545 の最小限の iCalendar(1件)。外部カレンダーとの双方向同期は Pro 版候補 */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function fmt(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** 75オクテットで折り返し(UTF-8 の文字境界を壊さない) */
function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > 73) {
      out.push(cur);
      cur = ' ';
      bytes = 1;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}

export interface IcsEvent {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  location: string;
  description: string;
  canceled?: boolean;
}

function eventLines(e: IcsEvent, now: Date): string[] {
  return [
    'BEGIN:VEVENT',
    `UID:${esc(e.uid)}`,
    `DTSTAMP:${fmt(now)}`,
    `DTSTART:${fmt(e.start)}`,
    `DTEND:${fmt(e.end)}`,
    `SUMMARY:${esc(e.summary)}`,
    `LOCATION:${esc(e.location)}`,
    `DESCRIPTION:${esc(e.description)}`,
    `STATUS:${e.canceled ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
  ];
}

export function buildIcs(e: IcsEvent & { now: Date }): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ServiceHub//Booking//JA',
    'CALSCALE:GREGORIAN',
    `METHOD:${e.canceled ? 'CANCEL' : 'PUBLISH'}`,
    ...eventLines(e, e.now),
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** 複数予約をまとめた iCalendar(管理側の一括出力。Googleカレンダー等への取り込み用) */
export function buildIcsCalendar(events: IcsEvent[], now: Date, name: string): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ServiceHub//Bookings//JA',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`,
    ...events.flatMap((e) => eventLines(e, now)),
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}
