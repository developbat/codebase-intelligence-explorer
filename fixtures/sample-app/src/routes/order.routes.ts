import { OrderController } from "../controllers/order.controller";
import { EmailService } from "../services/email.service";
import { OrderService } from "../services/order.service";
import { PaymentService } from "../services/payment.service";
import { OrderRepository } from "../repositories/order.repository";
import { UserRepository } from "../repositories/user.repository";

export interface RouteDefinition {
  method: "GET" | "POST" | "DELETE";
  path: string;
  handler: string;
}

export function buildRoutes(orderService: OrderService): RouteDefinition[] {
  const controller = new OrderController(orderService);
  return [
    { method: "POST", path: "/orders", handler: controller.create.name },
    { method: "GET", path: "/orders", handler: controller.list.name },
    { method: "DELETE", path: "/orders/:id", handler: controller.cancel.name },
  ];
}

export function createContainer() {
  const orderRepository = new OrderRepository();
  const userRepository = new UserRepository();
  const paymentService = new PaymentService();
  const emailService = new EmailService();
  const orderService = new OrderService(orderRepository, userRepository, paymentService, emailService);
  return { orderService, orderRepository, userRepository, paymentService, emailService };
}
