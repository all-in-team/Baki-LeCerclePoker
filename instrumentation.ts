export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initCronJobs } = await import("./lib/cron");
    initCronJobs();

    // Sonde du chat admin : les Sujets y sont-ils activés ? Le warning doit sortir
    // au démarrage, pas au premier lead — sans ça, une bascule ratée ne se voit
    // qu'en constatant que les topics ne se créent pas. Non bloquant : si Telegram
    // ne répond pas, le relais démarre en mode plat et resonde plus tard.
    void (async () => {
      try {
        const { adminChatId } = await import("./lib/funnels/telegram-api");
        const { probeForumAtStartup } = await import("./lib/funnels/live-takeover-topics");
        await probeForumAtStartup(adminChatId());
      } catch (e: any) {
        console.error("[BOOT] sonde Sujets du chat admin échouée:", e?.message ?? e);
      }
    })();

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
