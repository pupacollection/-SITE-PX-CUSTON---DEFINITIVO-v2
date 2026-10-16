import { supabase } from '../lib/supabase';
import { EventItem } from '../types';

/**
 * Utilitário para gerar slug amigável a partir do título do evento
 */
export function generateEventSlug(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

/**
 * Utilitário para formatar data em padrão oficial de exibição (ex: "15 NOV 2025")
 */
export function formatDisplayDate(dateInput: string): string {
  try {
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return dateInput;

    const months = [
      'JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN',
      'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'
    ];
    const day = String(d.getDate()).padStart(2, '0');
    const month = months[d.getMonth()];
    const year = d.getFullYear();

    return `${day} ${month} ${year}`;
  } catch {
    return dateInput;
  }
}

export interface CreateEventInput {
  title: string;
  slug: string;
  subtitle?: string;
  date: string;
  formatted_date: string;
  location: string;
  city: string;
  state: string;
  min_price: number;
  cover_image: string;
  gallery_images?: string[];
  description: string;
  tags?: string[];
  classification?: string;
  rules?: string[];
  status: 'draft' | 'published' | 'finished';
}

export interface UpdateEventInput extends Partial<CreateEventInput> {}

/**
 * Consulta todos os eventos reais diretamente do Supabase (para uso no PX CONTROL)
 * Inclui eventos em rascunho ('draft'), publicados ('published') e finalizados ('finished').
 */
export async function getAdminEvents(): Promise<{ data: EventItem[] | null; error: string | null }> {
  try {
    const { data, error } = await supabase
      .from('events')
      .select('*, ticket_batches(*)')
      .order('date', { ascending: true });

    if (error) {
      return { data: null, error: error.message };
    }

    const mappedEvents: EventItem[] = (data || []).map((row: any) => ({
      id: row.id,
      title: row.title,
      slug: row.slug,
      subtitle: row.subtitle || undefined,
      date: row.date,
      formatted_date: row.formatted_date || formatDisplayDate(row.date),
      location: row.location,
      city: row.city,
      state: row.state,
      min_price: typeof row.min_price === 'number' ? row.min_price : parseFloat(row.min_price || '0'),
      cover_image: row.cover_image,
      gallery_images: row.gallery_images || [],
      description: row.description,
      tags: row.tags || [],
      classification: row.classification || 'Classificação 16 anos',
      rules: row.rules || [],
      is_official: Boolean(row.is_official),
      is_demo: Boolean(row.is_demo),
      status: (row.status as 'draft' | 'published' | 'finished') || 'published',
      ticket_batches: row.ticket_batches || [],
    }));

    return { data: mappedEvents, error: null };
  } catch (err: any) {
    return { data: null, error: err?.message || 'Falha de conexão com o Supabase ao carregar eventos.' };
  }
}

/**
 * Cria um novo evento oficial no banco de dados Supabase com validações de integridade
 */
export async function createAdminEvent(
  input: CreateEventInput,
  userId?: string
): Promise<{ data: EventItem | null; error: string | null }> {
  try {
    // Validação estrita de campos obrigatórios do esquema
    if (!input.title || input.title.trim().length < 3) {
      return { data: null, error: 'O título do evento deve ter no mínimo 3 caracteres.' };
    }
    if (!input.slug || input.slug.trim().length < 2) {
      return { data: null, error: 'O slug do evento é obrigatório.' };
    }
    if (!input.date) {
      return { data: null, error: 'A data do evento é obrigatória.' };
    }
    if (!input.location || input.location.trim().length < 2) {
      return { data: null, error: 'O local do evento é obrigatório.' };
    }
    if (!input.city || !input.state) {
      return { data: null, error: 'Cidade e Estado são obrigatórios.' };
    }
    if (!input.cover_image || input.cover_image.trim().length < 5) {
      return { data: null, error: 'A imagem de capa é obrigatória.' };
    }
    if (!input.description || input.description.trim().length < 10) {
      return { data: null, error: 'A descrição do evento deve ter no mínimo 10 caracteres.' };
    }

    const payload = {
      title: input.title.trim(),
      slug: input.slug.trim().toLowerCase(),
      subtitle: input.subtitle ? input.subtitle.trim() : null,
      date: new Date(input.date).toISOString(),
      formatted_date: input.formatted_date ? input.formatted_date.trim() : formatDisplayDate(input.date),
      location: input.location.trim(),
      city: input.city.trim(),
      state: input.state.trim().toUpperCase(),
      min_price: Math.max(0, input.min_price || 0),
      cover_image: input.cover_image.trim(),
      gallery_images: input.gallery_images || [],
      description: input.description.trim(),
      tags: input.tags || ['Carros Rebaixados', 'PX CUSTON'],
      classification: input.classification || 'Classificação 16 anos',
      rules: input.rules || ['Apresentação de documento oficial na portaria'],
      is_official: true,
      is_demo: false,
      status: input.status || 'published',
      created_by: userId || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('events')
      .insert(payload)
      .select('*, ticket_batches(*)')
      .single();

    if (error) {
      if (error.code === '23505' || error.message.includes('unique')) {
        return { data: null, error: `Já existe um evento cadastrado com o slug "${input.slug}". Por favor, altere o slug.` };
      }
      return { data: null, error: error.message };
    }

    return {
      data: {
        id: data.id,
        title: data.title,
        slug: data.slug,
        subtitle: data.subtitle || undefined,
        date: data.date,
        formatted_date: data.formatted_date,
        location: data.location,
        city: data.city,
        state: data.state,
        min_price: typeof data.min_price === 'number' ? data.min_price : parseFloat(data.min_price || '0'),
        cover_image: data.cover_image,
        gallery_images: data.gallery_images || [],
        description: data.description,
        tags: data.tags || [],
        classification: data.classification || 'Classificação 16 anos',
        rules: data.rules || [],
        is_official: data.is_official,
        is_demo: data.is_demo,
        status: data.status,
        ticket_batches: data.ticket_batches || [],
      },
      error: null,
    };
  } catch (err: any) {
    return { data: null, error: err?.message || 'Erro inesperado ao registrar evento no Supabase.' };
  }
}

/**
 * Atualiza um evento existente no banco de dados Supabase
 */
export async function updateAdminEvent(
  id: string,
  input: UpdateEventInput
): Promise<{ data: EventItem | null; error: string | null }> {
  try {
    const payload: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (input.title !== undefined) payload.title = input.title.trim();
    if (input.slug !== undefined) payload.slug = input.slug.trim().toLowerCase();
    if (input.subtitle !== undefined) payload.subtitle = input.subtitle ? input.subtitle.trim() : null;
    if (input.date !== undefined) {
      payload.date = new Date(input.date).toISOString();
      if (!input.formatted_date) {
        payload.formatted_date = formatDisplayDate(input.date);
      }
    }
    if (input.formatted_date !== undefined) payload.formatted_date = input.formatted_date.trim();
    if (input.location !== undefined) payload.location = input.location.trim();
    if (input.city !== undefined) payload.city = input.city.trim();
    if (input.state !== undefined) payload.state = input.state.trim().toUpperCase();
    if (input.min_price !== undefined) payload.min_price = Math.max(0, input.min_price);
    if (input.cover_image !== undefined) payload.cover_image = input.cover_image.trim();
    if (input.gallery_images !== undefined) payload.gallery_images = input.gallery_images;
    if (input.description !== undefined) payload.description = input.description.trim();
    if (input.tags !== undefined) payload.tags = input.tags;
    if (input.classification !== undefined) payload.classification = input.classification;
    if (input.rules !== undefined) payload.rules = input.rules;
    if (input.status !== undefined) payload.status = input.status;

    const { data, error } = await supabase
      .from('events')
      .update(payload)
      .eq('id', id)
      .select('*, ticket_batches(*)')
      .single();

    if (error) {
      if (error.code === '23505' || error.message.includes('unique')) {
        return { data: null, error: `Conflito de identificador: O slug já está em uso por outro evento.` };
      }
      return { data: null, error: error.message };
    }

    return {
      data: {
        id: data.id,
        title: data.title,
        slug: data.slug,
        subtitle: data.subtitle || undefined,
        date: data.date,
        formatted_date: data.formatted_date,
        location: data.location,
        city: data.city,
        state: data.state,
        min_price: typeof data.min_price === 'number' ? data.min_price : parseFloat(data.min_price || '0'),
        cover_image: data.cover_image,
        gallery_images: data.gallery_images || [],
        description: data.description,
        tags: data.tags || [],
        classification: data.classification || 'Classificação 16 anos',
        rules: data.rules || [],
        is_official: data.is_official,
        is_demo: data.is_demo,
        status: data.status,
        ticket_batches: data.ticket_batches || [],
      },
      error: null,
    };
  } catch (err: any) {
    return { data: null, error: err?.message || 'Erro inesperado ao atualizar evento no Supabase.' };
  }
}

/**
 * Altera rapidamente o estado de publicação do evento ('published', 'draft', 'finished')
 */
export async function toggleEventStatus(
  id: string,
  newStatus: 'draft' | 'published' | 'finished'
): Promise<{ error: string | null }> {
  try {
    const { error } = await supabase
      .from('events')
      .update({
        status: newStatus,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) {
      return { error: error.message };
    }

    return { error: null };
  } catch (err: any) {
    return { error: err?.message || 'Erro inesperado ao alterar status do evento.' };
  }
}
