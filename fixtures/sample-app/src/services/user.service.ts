import type { Order } from "../domain/order";
import type { User } from "../repositories/user.repository";
import { UserRepository } from "../repositories/user.repository";
import { OrderService } from "./order.service";

export class UserService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly orderService: OrderService,
  ) {}

  async getUser(userId: string): Promise<User> {
    const user = await this.userRepository.findById(userId);
    if (!user) throw new Error("Kullanıcı bulunamadı");
    return user;
  }

  async listUsers(): Promise<User[]> {
    return this.userRepository.findAll();
  }

  async getUserOrders(userId: string): Promise<Order[]> {
    await this.getUser(userId);
    return this.orderService.getOrdersByUser(userId);
  }
}
