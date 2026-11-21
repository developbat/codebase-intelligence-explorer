import { UserService } from "../services/user.service";
import { formatError, log } from "../utils/logger";

export class UserController {
  constructor(private readonly userService: UserService) {}

  async get(userId: string) {
    try {
      log("user.get", { userId });
      const user = await this.userService.getUser(userId);
      return { status: 200, body: user };
    } catch (error) {
      const message = formatError(error);
      log("user.get.failed", { userId, message });
      return { status: 404, body: { error: message } };
    }
  }

  async list() {
    const users = await this.userService.listUsers();
    return { status: 200, body: users };
  }

  async orders(userId: string) {
    try {
      log("user.orders", { userId });
      const orders = await this.userService.getUserOrders(userId);
      return { status: 200, body: orders };
    } catch (error) {
      const message = formatError(error);
      log("user.orders.failed", { userId, message });
      return { status: 404, body: { error: message } };
    }
  }
}
