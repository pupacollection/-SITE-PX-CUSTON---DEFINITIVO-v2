-- ==============================================================================
-- PX CUSTON — MIGRATION: GESTÃO ESTENDIDA DE LOTES DE INGRESSOS (ticket_batches)
-- ==============================================================================
-- Adiciona suporte a períodos de venda (start_date, end_date) de forma 100% incremental,
-- compatível com os dados existentes e sem quebrar registros ou tabelas existentes.

ALTER TABLE public.ticket_batches 
  ADD COLUMN IF NOT EXISTS start_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS end_date TIMESTAMPTZ;

-- Adicionar índice para otimizar consultas por evento e status do lote
CREATE INDEX IF NOT EXISTS idx_ticket_batches_event_active 
  ON public.ticket_batches(event_id, is_active);

-- Documentação de schema
COMMENT ON COLUMN public.ticket_batches.start_date IS 'Data e hora oficial de início das vendas deste lote (opcional).';
COMMENT ON COLUMN public.ticket_batches.end_date IS 'Data e hora oficial de encerramento das vendas deste lote (opcional).';
