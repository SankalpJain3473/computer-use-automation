export function readKeys(): { agent: string; operator: string };
export function bearer(key: string): { Authorization: string };
