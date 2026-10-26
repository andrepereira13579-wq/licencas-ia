// Service worker mínimo: permite instalar o app na tela inicial. Não guarda dados de clientes.
self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => self.clients.claim());
self.addEventListener("fetch", () => {});
