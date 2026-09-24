/* HarnessGate Service Worker：仅为满足 PWA 可安装性（Android Chrome 要求有 fetch 处理器）。
 * 刻意不做资源缓存——控制面要的是实时状态，缓存会造成版本/数据陈旧问题。 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
