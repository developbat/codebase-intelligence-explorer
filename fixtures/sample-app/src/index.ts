import { buildRoutes, createContainer } from "./routes/order.routes";
import { log } from "./utils/logger";

async function bootstrap(): Promise<void> {
  const container = createContainer();
  const routes = buildRoutes(container.orderService);
  log("app.started", { routes: routes.length });
  console.log("Kullanılabilir rotalar:", routes.map((route) => `${route.method} ${route.path}`).join(", "));
}

bootstrap().catch((error) => {
  log("app.failed", { error: String(error) });
  process.exitCode = 1;
});
