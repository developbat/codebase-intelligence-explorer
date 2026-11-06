import type { Order, OrderStatus } from "../domain/order";

export class OrderRepository {
  private readonly orders = new Map<string, Order>();

  async create(order: Order): Promise<Order> {
    this.orders.set(order.id, order);
    return order;
  }

  async findById(orderId: string): Promise<Order | null> {
    return this.orders.get(orderId) ?? null;
  }

  async findByUser(userId: string): Promise<Order[]> {
    return [...this.orders.values()].filter((order) => order.userId === userId);
  }

  async updateStatus(orderId: string, status: OrderStatus): Promise<Order | null> {
    const order = await this.findById(orderId);
    if (!order) return null;
    const updated: Order = { ...order, status };
    this.orders.set(orderId, updated);
    return updated;
  }

  async delete(orderId: string): Promise<boolean> {
    return this.orders.delete(orderId);
  }
}
