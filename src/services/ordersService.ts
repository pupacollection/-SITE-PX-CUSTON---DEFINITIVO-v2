/**
 * PX CUSTON — Serviço de Pedidos e Checkout Autoritativo
 * Comunicação direta com a API do servidor e persistência segura no PostgreSQL/Supabase.
 */

import { supabase } from '../lib/supabase';
import { PaymentMethod, PaymentStatus } from '../types';

export interface CheckoutItemRequest {
  batch_id: string;
  batch_name?: string;
  quantity: number;
  unit_price?: number;
}

export interface BuyerInfoRequest {
  id?: string;
  name: string;
  email: string;
  cpf?: string;
}

export interface CreateOrderPayload {
  event_id: string;
  event_title?: string;
  items: CheckoutItemRequest[];
  buyer: BuyerInfoRequest;
  payment_method: PaymentMethod;
}

export interface CreateOrderResponse {
  success: boolean;
  order: {
    id: string;
    user_id: string;
    event_id: string;
    event_title: string;
    items: Array<{
      batch_id: string;
      batch_name: string;
      quantity: number;
      unit_price: number;
      subtotal: number;
    }>;
    subtotal: number;
    convenience_fee: number;
    discount: number;
    total: number;
    payment_method: PaymentMethod;
    payment_status: PaymentStatus;
    created_at: string;
  };
  payment: {
    status: PaymentStatus;
    method: PaymentMethod;
    preference_id: string;
    pix_copy_paste?: string | null;
    expires_at?: string;
    expires_in_seconds?: number;
    message: string;
    gateway_ready?: boolean;
  };
}

export interface OrderStatusResponse {
  id: string;
  status: PaymentStatus;
  total: number;
  updated_at: string;
  expired?: boolean;
  message?: string;
}

export const ordersService = {
  /**
   * Envia o pedido para criação autoritativa e reserva de estoque atômica no servidor.
   */
  async createOrder(payload: CreateOrderPayload): Promise<CreateOrderResponse> {
    const { data: { session } } = await supabase.auth.getSession();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (session?.access_token) {
      headers['Authorization'] = `Bearer ${session.access_token}`;
    }

    const response = await fetch('/api/orders/create', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Falha ao registrar pedido.');
    }

    return data as CreateOrderResponse;
  },

  /**
   * Consulta o status atual de um pedido no backend (com validação automática de expiração).
   */
  async getOrderStatus(orderId: string): Promise<OrderStatusResponse> {
    const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/status`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Pedido não encontrado.');
    }

    return data as OrderStatusResponse;
  },
};
