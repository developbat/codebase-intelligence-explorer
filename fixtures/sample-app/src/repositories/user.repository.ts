export interface User {
  id: string;
  email: string;
  name: string;
  active: boolean;
}

export class UserRepository {
  private readonly users = new Map<string, User>();

  async findById(userId: string): Promise<User | null> {
    return this.users.get(userId) ?? null;
  }

  async save(user: User): Promise<void> {
    if (!user.email.includes("@")) {
      throw new Error("Geçersiz e-posta adresi");
    }
    this.users.set(user.id, user);
  }

  async deactivate(userId: string): Promise<void> {
    const user = await this.findById(userId);
    if (!user) return;
    this.users.set(userId, { ...user, active: false });
  }
}
