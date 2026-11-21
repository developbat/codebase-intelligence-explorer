import { OrderController } from "../controllers/order.controller";
import { UserController } from "../controllers/user.controller";
import { EmailService } from "../services/email.service";
import { OrderService } from "../services/order.service";
import { PaymentService } from "../services/payment.service";
import { UserService } from "../services/user.service";
import { OrderRepository } from "../repositories/order.repository";
import { UserRepository } from "../repositories/user.repository";
import type { RouteDefinition } from "./types";

export type { RouteDefinition } from "./types";

export function buildRoutes(
  orderService: OrderService,
  userService: UserService,
): RouteDefinition[] {
  const controller = new OrderController(orderService);
  const userController = new UserController(userService);
  return [
    { method: "POST", path: "/orders", handler: controller.create.name },
    { method: "GET", path: "/orders", handler: controller.list.name },
    { method: "DELETE", path: "/orders/:id", handler: controller.cancel.name },
    { method: "GET", path: "/users", handler: userController.list.name },
    { method: "GET", path: "/users/:id", handler: userController.get.name },
    { method: "GET", path: "/users/:id/orders", handler: userController.orders.name },
  ];
}

export function createContainer() {
  const orderRepository = new OrderRepository();
  const userRepository = new UserRepository();
  const paymentService = new PaymentService();
  const emailService = new EmailService();
  const orderService = new OrderService(orderRepository, userRepository, paymentService, emailService);
  const userService = new UserService(userRepository, orderService);
  return { orderService, userService, orderRepository, userRepository, paymentService, emailService };
}
