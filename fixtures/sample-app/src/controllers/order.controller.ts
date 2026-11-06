import type { OrderItem } from "../domain/order";
import { OrderService } from "../services/order.service";
import { log } from "../utils/logger";

export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  async create(userId: string, items: OrderItem[]) {
    try {
      log("order.create", { userId, itemCount: items.length });
      const order = await this.orderService.createOrder(userId, items);
      return { status: 201, body: order };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Bilinmeyen hata";
      log("order.create.failed", { userId, message });
      return { status: 400, body: { error: message } };
    }
  }

  async list(userId: string) {
    const orders = await this.orderService.getOrdersByUser(userId);
    return { status: 200, body: orders };
  }

  async cancel(orderId: string) {
    const cancelled = await this.orderService.cancelOrder(orderId);
    return cancelled
      ? { status: 200, body: { cancelled: true } }
      : { status: 404, body: { error: "Sipariş bulunamadı" } };
  }
}
