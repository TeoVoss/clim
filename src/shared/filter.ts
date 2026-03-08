/**
 * Event filter utilities shared by `clim on`, `clim watch`, and the hook engine.
 */

export function parseFilter(filterStr: string): Map<string, string> {
  const filters = new Map<string, string>();

  for (const part of filterStr.split(',')) {
    const eqIndex = part.indexOf('=');
    if (eqIndex === -1) continue;

    const key = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    if (key && value) filters.set(key, value);
  }

  return filters;
}

export function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === value;

  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(value);
}

function resolveField(event: Record<string, unknown>, key: string): string {
  if (key in event) return String(event[key] ?? '');

  const payload = event.payload;
  if (typeof payload === 'object' && payload !== null && key in (payload as Record<string, unknown>)) {
    return String((payload as Record<string, unknown>)[key] ?? '');
  }

  return '';
}

export function matchesFilter(event: Record<string, unknown>, filter: Map<string, string>): boolean {
  for (const [key, pattern] of filter) {
    if (!globMatch(pattern, resolveField(event, key))) return false;
  }

  return true;
}

export function expandTemplate(template: string, event: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match: string, field: string) => {
    return resolveField(event, field);
  });
}
