import type { Order, OrderItem } from "../domain/order";
import { OrderRepository } from "../repositories/order.repository";
import { UserRepository } from "../repositories/user.repository";
import { PaymentService } from "./payment.service";
import { EmailService } from "./email.service";

export class OrderService {
  constructor(
    private readonly orderRepository: OrderRepository,
    private readonly userRepository: UserRepository,
    private readonly paymentService: PaymentService,
    private readonly emailService: EmailService,
  ) {}

  async createOrder(userId: string, items: OrderItem[]): Promise<Order> {
    const user = await this.userRepository.findById(userId);
    if (!user) throw new Error("Kullanıcı bulunamadı");
    if (!user.active) throw new Error("Kullanıcı pasif durumda");

    this.validateItems(items);
    const total = this.calculateTotal(items);
    await this.reserveStock(items);

    const order: Order = {
      id: `ord_${Date.now()}`,
      userId,
      items,
      total,
      status: "pending",
    };

    await this.orderRepository.create(order);
    const payment = await this.paymentService.charge(userId, total);
    if (!payment.success) {
      await this.releaseStock(items);
      throw new Error("Ödeme alınamadı");
    }

    await this.emailService.sendOrderConfirmation(user.email, order.id);
    return this.orderRepository.updateStatus(order.id, "paid") as Promise<Order>;
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    const order = await this.getOrderById(orderId);
    if (!order) return false;
    await this.releaseStock(order.items);
    await this.orderRepository.updateStatus(orderId, "cancelled");
    return true;
  }

  async getOrderById(orderId: string): Promise<Order | null> {
    return this.orderRepository.findById(orderId);
  }

  async getOrdersByUser(userId: string): Promise<Order[]> {
    return this.orderRepository.findByUser(userId);
  }

  calculateTotal(items: OrderItem[]): number {
    return items.reduce((total, item) => total + item.quantity * item.unitPrice, 0);
  }

  validateItems(items: OrderItem[]): void {
    if (items.length === 0) throw new Error("Sipariş en az bir ürün içermelidir");
    for (const item of items) {
      if (item.quantity <= 0) throw new Error("Ürün adedi geçersiz");
      if (item.unitPrice < 0) throw new Error("Ürün fiyatı geçersiz");
    }
  }

  private async reserveStock(items: OrderItem[]): Promise<void> {
    for (const item of items) {
      if (!item.productId) throw new Error("Ürün kimliği eksik");
    }
  }

  private async releaseStock(items: OrderItem[]): Promise<void> {
    if (items.length === 0) return;
    // Stok rezervasyonu geri bırakılır.
  }
}
