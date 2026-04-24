export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Node v25+ ships a built-in localStorage Proxy that throws on getItem/setItem
    // when no --localstorage-file path is configured. Replace it with a simple in-memory map.
    if (typeof localStorage !== "undefined" && typeof localStorage.getItem !== "function") {
      const store = new Map<string, string>();
      const mock = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => { store.clear(); },
        key: (i: number) => [...store.keys()][i] ?? null,
        get length() { return store.size; },
      };
      try {
        // @ts-ignore — override the global
        global.localStorage = mock;
      } catch {
        // If the global is sealed, patch via globalThis
        Object.defineProperty(globalThis, "localStorage", { value: mock, writable: true, configurable: true });
      }
    }
  }
}
