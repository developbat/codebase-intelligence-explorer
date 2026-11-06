export class EmailService {
  private readonly outbox: { to: string; subject: string; body: string }[] = [];

  async sendOrderConfirmation(email: string, orderId: string): Promise<void> {
    this.outbox.push({
      to: email,
      subject: `Siparişiniz alındı: ${orderId}`,
      body: `Sipariş numaranız ${orderId}. Bizi tercih ettiğiniz için teşekkürler.`,
    });
  }

  getOutboxSize(): number {
    return this.outbox.length;
  }
}
