const marked = new WeakSet<object>();

export function markLibraryVerified(value: object): void {
  marked.add(value);
}

export function isLibraryVerified(value: object): boolean {
  return marked.has(value);
}
