import { toast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";

/**
 * Registers public/sw.js (production builds only; main.tsx gates on
 * import.meta.env.PROD). When a new worker finishes installing while an old
 * one still controls the page, it waits; we offer a "New version available"
 * toast whose Reload action tells it to take over, then reload once it has.
 */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  let reloadRequested = false;

  function offerUpdate(worker: ServiceWorker) {
    toast({
      title: "New version available",
      duration: Infinity,
      action: (
        <ToastAction
          altText="Reload to update"
          onClick={() => {
            reloadRequested = true;
            worker.postMessage({ type: "SKIP_WAITING" });
          }}
        >
          Reload
        </ToastAction>
      ),
    });
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((registration) => {
        if (registration.waiting && navigator.serviceWorker.controller) {
          offerUpdate(registration.waiting);
        }

        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            // No controller means this is the first install, not an update.
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              offerUpdate(installing);
            }
          });
        });

        // Floor phones keep the app open for days; look for a new build
        // whenever the app comes back to the foreground.
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") void registration.update().catch(() => undefined);
        });
      })
      .catch((err) => {
        console.warn("[pwa] service worker registration failed", err);
      });

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!reloadRequested) return;
      reloadRequested = false;
      window.location.reload();
    });
  });
}
