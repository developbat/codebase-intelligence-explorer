export interface OrderItem {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

export type OrderStatus = "pending" | "paid" | "shipped" | "cancelled";

export interface Order {
  id: string;
  userId: string;
  items: OrderItem[];
  total: number;
  status: OrderStatus;
}
