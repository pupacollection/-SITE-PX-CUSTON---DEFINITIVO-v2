import React, { useState } from 'react';
import { EventItem, TicketBatch, ActiveScreen } from '../types';
import {
  Calendar,
  MapPin,
  Clock,
  ShieldAlert,
  Car,
  Utensils,
  Volume2,
  Check,
  Plus,
  Minus,
  ArrowLeft,
  Share2,
} from 'lucide-react';

interface EventDetailViewProps {
  event: EventItem;
  onBack: () => void;
  onProceedToCheckout: (event: EventItem, selectedBatches: { batch: TicketBatch; quantity: number }[]) => void;
  onNavigate: (screen: ActiveScreen) => void;
}

export const EventDetailView: React.FC<EventDetailViewProps> = ({
  event,
  onBack,
  onProceedToCheckout,
  onNavigate,
}) => {
  const initialBatch = event.ticket_batches.find((b) => b.is_active && b.available_quantity > 0);
  const [quantities, setQuantities] = useState<Record<string, number>>(
    initialBatch ? { [initialBatch.id]: 1 } : {}
  );

  const updateQuantity = (batchId: string, delta: number) => {
    const targetBatch = event.ticket_batches.find((b) => b.id === batchId);
    if (targetBatch && (!targetBatch.is_active || targetBatch.available_quantity <= 0)) {
      return;
    }
    const maxAllowed = targetBatch ? Math.min(10, targetBatch.available_quantity) : 10;
    setQuantities((prev) => {
      const current = prev[batchId] || 0;
      const next = Math.max(0, Math.min(maxAllowed, current + delta));
      return { ...prev, [batchId]: next };
    });
  };

  const totalSelected = Object.values(quantities).reduce((acc, q) => acc + q, 0);

  const handleBuy = (targetBatch?: TicketBatch) => {
    if (targetBatch && (!targetBatch.is_active || targetBatch.available_quantity <= 0)) {
      return;
    }
    const selectedBatches = event.ticket_batches
      .filter((b) => b.is_active && b.available_quantity > 0)
      .map((batch) => ({
        batch,
        quantity: targetBatch?.id === batch.id ? Math.max(1, quantities[batch.id] || 1) : (quantities[batch.id] || 0),
      }))
      .filter((item) => item.quantity > 0);

    if (selectedBatches.length === 0 && targetBatch && targetBatch.is_active && targetBatch.available_quantity > 0) {
      selectedBatches.push({ batch: targetBatch, quantity: 1 });
    }

    if (selectedBatches.length > 0) {
      onProceedToCheckout(event, selectedBatches);
    }
  };

  return (
    <div className="min-h-screen bg-[#000000] text-white py-8 pb-24 md:pb-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Navigation & Share Bar */}
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-2 text-xs font-semibold text-zinc-400 hover:text-white bg-[#141414] border border-[#2a2a2a] px-3.5 py-2 rounded-xl transition"
          >
            <ArrowLeft className="w-4 h-4 text-[#FF1A2D] shrink-0" />
            <span>Voltar aos Eventos</span>
          </button>

          <button
            type="button"
            onClick={() => {
              if (navigator.share) {
                navigator.share({
                  title: event.title,
                  text: event.subtitle,
                  url: window.location.href,
                });
              }
            }}
            className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-white bg-[#141414] border border-[#2a2a2a] px-3 py-2 rounded-xl shrink-0"
          >
            <Share2 className="w-4 h-4 text-[#FF1A2D] shrink-0" />
            <span>Compartilhar</span>
          </button>
        </div>

        {/* Hero Banner / Gallery Showcase */}
        <div className="relative rounded-3xl overflow-hidden border border-[#262626] bg-[#111111]">
          <div className="relative h-64 sm:h-96 w-full">
            <img
              src={event.cover_image}
              alt={event.title}
              className="w-full h-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-[#111111] via-[#111111]/60 to-transparent" />
            
            {/* Badges */}
            <div className="absolute top-4 left-4 right-4 flex flex-wrap items-center gap-2">
              {event.is_demo ? (
                <span className="bg-amber-600 text-white text-xs font-black uppercase tracking-widest px-3 py-1 rounded-lg shadow-lg">
                  Homologação Técnica (DEMO)
                </span>
              ) : (
                <span className="bg-[#FF1A2D] text-white text-xs font-black uppercase tracking-widest px-3 py-1 rounded-lg shadow-lg">
                  Evento Oficial
                </span>
              )}
              <span className="bg-black/70 backdrop-blur-md border border-white/10 text-white text-xs px-3 py-1 rounded-lg">
                PX CUSTON
              </span>
            </div>
          </div>

          {/* Event Header Info */}
          <div className="p-5 sm:p-8 -mt-12 sm:-mt-16 relative z-10">
            {event.is_demo && (
              <div className="mb-6 bg-amber-950/40 border border-amber-500/40 rounded-2xl p-4 flex items-center gap-3 text-amber-200 text-xs">
                <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0" />
                <div>
                  <span className="font-bold uppercase tracking-wider block">Evento de Demonstração & Homologação</span>
                  <span className="text-zinc-300">
                    Este evento possui caráter demonstrativo para validação técnica da plataforma. Pagamentos reais e vendas comerciais oficiais estão desabilitados.
                  </span>
                </div>
              </div>
            )}

            <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
              <div className="min-w-0">
                <h1 className="text-2xl sm:text-4xl font-black uppercase tracking-tight text-white font-heading break-words">
                  {event.title}
                </h1>
                <div className="flex flex-wrap items-center gap-2.5 sm:gap-4 text-xs sm:text-sm text-zinc-300 mt-3">
                  <span className="flex items-center gap-1.5 bg-[#181818] px-3 py-1.5 rounded-lg border border-[#2a2a2a]">
                    <Calendar className="w-4 h-4 text-[#FF1A2D] shrink-0" />
                    <span>{event.formatted_date}</span>
                  </span>
                  <span className="flex items-center gap-1.5 bg-[#181818] px-3 py-1.5 rounded-lg border border-[#2a2a2a]">
                    <MapPin className="w-4 h-4 text-[#FF1A2D] shrink-0" />
                    <span>{event.location} • {event.city}/{event.state}</span>
                  </span>
                </div>
              </div>

              <div className="bg-[#181818] border border-[#2a2a2a] p-4 rounded-2xl text-left md:text-right shrink-0">
                <span className="text-[11px] text-zinc-400 block">Lotes disponíveis a partir de</span>
                <span className="text-2xl font-black text-[#FF1A2D]">
                  R$ {event.min_price.toFixed(2).replace('.', ',')}
                </span>
              </div>
            </div>

            {/* Description */}
            <div className="mt-6 pt-6 border-t border-[#1f1f1f]">
              <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-2">
                Sobre a Experiência
              </h3>
              <p className="text-zinc-300 text-sm leading-relaxed max-w-4xl">
                {event.description}
              </p>
            </div>

            {/* Tags */}
            <div className="mt-4 flex flex-wrap gap-2">
              {event.tags.map((tag) => (
                <span
                  key={tag}
                  className="bg-[#1a1a1a] border border-[#2c2c2c] text-zinc-300 text-xs px-3 py-1 rounded-full font-medium"
                >
                  {tag}
                </span>
              ))}
            </div>

            {/* Rules / Facilities Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-6 pt-6 border-t border-[#1f1f1f]">
              <div className="flex items-center gap-2.5 bg-[#161616] border border-[#242424] p-3 rounded-xl text-xs text-zinc-300">
                <ShieldAlert className="w-4 h-4 text-[#FF1A2D] shrink-0" />
                <span>{event.classification}</span>
              </div>
              <div className="flex items-center gap-2.5 bg-[#161616] border border-[#242424] p-3 rounded-xl text-xs text-zinc-300">
                <Utensils className="w-4 h-4 text-[#FF1A2D] shrink-0" />
                <span>Proibida entrada de bebidas</span>
              </div>
              <div className="flex items-center gap-2.5 bg-[#161616] border border-[#242424] p-3 rounded-xl text-xs text-zinc-300">
                <Car className="w-4 h-4 text-[#FF1A2D] shrink-0" />
                <span>Estacionamento no local</span>
              </div>
            </div>
          </div>
        </div>

        {/* Lotes de Ingressos (Screen 05 Core Feature) */}
        <div className="bg-[#121212] border border-[#222] rounded-3xl p-5 sm:p-8">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
            <div>
              <h2 className="text-xl font-black uppercase tracking-tight text-white font-heading">
                Lotes de Ingressos Oficiais
              </h2>
              <p className="text-xs text-zinc-400 mt-1">
                Selecione os ingressos desejados para finalizar a compra segura via Mercado Pago.
              </p>
            </div>
            {totalSelected > 0 && (
              <span className="text-xs font-bold text-[#FF1A2D] bg-[#FF1A2D]/10 border border-[#FF1A2D]/30 px-3 py-1 rounded-full w-fit shrink-0">
                {totalSelected} {totalSelected === 1 ? 'ingresso' : 'ingressos'} selecionados
              </span>
            )}
          </div>

          <div className="space-y-4">
            {event.ticket_batches.map((batch) => {
              const qty = quantities[batch.id] || 0;
              const now = new Date();
              const isUpcoming = batch.start_date ? new Date(batch.start_date) > now : false;
              const isExpired = batch.end_date ? new Date(batch.end_date) < now : false;
              const isSoldOut = batch.available_quantity <= 0;
              const isUnavailable = !batch.is_active || isSoldOut || isUpcoming || isExpired;

              return (
                <div
                  key={batch.id}
                  className={`bg-[#181818] border p-4 sm:p-5 rounded-2xl flex flex-col lg:flex-row lg:items-center justify-between gap-4 sm:gap-5 transition ${
                    isUnavailable
                      ? 'border-[#222] opacity-60'
                      : 'border-[#262626] hover:border-[#383838]'
                  }`}
                >
                  <div className="max-w-md min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-black uppercase text-white tracking-wide">
                        {batch.name}
                      </h3>
                      {isSoldOut ? (
                        <span className="text-[10px] text-red-400 bg-red-950/60 px-2 py-0.5 rounded border border-red-500/30 font-bold uppercase">
                          Esgotado
                        </span>
                      ) : !batch.is_active ? (
                        <span className="text-[10px] text-zinc-400 bg-zinc-900 px-2 py-0.5 rounded border border-zinc-700 font-bold uppercase">
                          Indisponível
                        </span>
                      ) : isUpcoming ? (
                        <span className="text-[10px] text-amber-400 bg-amber-950/60 px-2 py-0.5 rounded border border-amber-500/30 font-bold uppercase">
                          Em Breve
                        </span>
                      ) : isExpired ? (
                        <span className="text-[10px] text-zinc-400 bg-zinc-900 px-2 py-0.5 rounded border border-zinc-700 font-bold uppercase">
                          Vendas Encerradas
                        </span>
                      ) : (
                        <span className="text-[10px] text-zinc-400 bg-[#111] px-2 py-0.5 rounded border border-[#222]">
                          {batch.available_quantity} restantes
                        </span>
                      )}
                    </div>
                    {batch.description && (
                      <p className="text-xs text-zinc-400 mt-1">{batch.description}</p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center justify-between sm:justify-end gap-3 sm:gap-5 pt-3 lg:pt-0 border-t lg:border-t-0 border-[#242424]">
                    <div className="text-left sm:text-right">
                      <span className="text-[10px] text-zinc-400 block uppercase">Valor Unitário</span>
                      <span className="text-lg font-black text-[#FF1A2D] whitespace-nowrap">
                        R$ {Number(batch.price).toFixed(2).replace('.', ',')}
                      </span>
                    </div>

                    <div className="flex items-center gap-2.5 sm:gap-4 ml-auto sm:ml-0">
                      {/* Quantity Selector [- 0 +] */}
                      <div className="flex items-center bg-[#121212] border border-[#2a2a2a] rounded-xl p-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => updateQuantity(batch.id, -1)}
                          disabled={isUnavailable}
                          aria-label="Diminuir quantidade"
                          className="w-8 h-8 rounded-lg bg-[#181818] hover:bg-[#222] disabled:opacity-30 disabled:cursor-not-allowed text-zinc-300 flex items-center justify-center transition"
                        >
                          <Minus className="w-3.5 h-3.5" />
                        </button>
                        <span className="w-8 sm:w-10 text-center font-bold text-xs text-white">
                          {isUnavailable ? 0 : qty}
                        </span>
                        <button
                          type="button"
                          onClick={() => updateQuantity(batch.id, 1)}
                          disabled={isUnavailable || qty >= batch.available_quantity}
                          aria-label="Aumentar quantidade"
                          className="w-8 h-8 rounded-lg bg-[#181818] hover:bg-[#222] disabled:opacity-30 disabled:cursor-not-allowed text-zinc-300 flex items-center justify-center transition"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleBuy(batch)}
                        disabled={isUnavailable}
                        className="bg-[#FF1A2D] hover:bg-[#e00f21] disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold uppercase tracking-wider px-4 sm:px-5 py-3 rounded-xl shadow-[0_0_15px_rgba(255,26,45,0.4)] transition shrink-0"
                      >
                        {isSoldOut ? 'Esgotado' : isUnavailable ? 'Indisponível' : 'Comprar'}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
