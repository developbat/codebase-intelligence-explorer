export interface ChargeResult {
  transactionId: string;
  amount: number;
  success: boolean;
}

export class PaymentService {
  private readonly transactions = new Map<string, ChargeResult>();

  async charge(userId: string, amount: number): Promise<ChargeResult> {
    if (amount <= 0) {
      throw new Error("Ödeme tutarı sıfırdan büyük olmalıdır");
    }
    const result: ChargeResult = {
      transactionId: `tx_${Date.now()}`,
      amount,
      success: true,
    };
    this.transactions.set(result.transactionId, result);
    return result;
  }

  async refund(transactionId: string): Promise<boolean> {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) return false;
    this.transactions.delete(transactionId);
    return true;
  }
}
