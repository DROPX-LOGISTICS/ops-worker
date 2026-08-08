import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { WorkforceAssociate } from '../types';

interface AssociateRow {
  transporter_id: string;
  full_name: string;
  provider_id: string | null;
  roles: string | null;
  qualifications: string | null;
  operational_status: string | null;
  personal_phone_number: string | null;
  work_phone_number: string | null;
  email_address: string | null;
  driver_license_expiration_date: string | null;
  photo_url: string | null;
  synced_at: string;
}

function toAssociate(row: AssociateRow): WorkforceAssociate {
  return {
    transporterId: row.transporter_id,
    fullName: row.full_name,
    providerId: row.provider_id,
    roles: row.roles,
    qualifications: row.qualifications,
    operationalStatus: row.operational_status,
    personalPhoneNumber: row.personal_phone_number,
    workPhoneNumber: row.work_phone_number,
    emailAddress: row.email_address,
    driverLicenseExpirationDate: row.driver_license_expiration_date,
    photoUrl: row.photo_url,
  };
}

function toRow(a: WorkforceAssociate): Omit<AssociateRow, 'synced_at'> & { synced_at?: string } {
  return {
    transporter_id: a.transporterId,
    full_name: a.fullName,
    provider_id: a.providerId,
    roles: a.roles,
    qualifications: a.qualifications,
    operational_status: a.operationalStatus,
    personal_phone_number: a.personalPhoneNumber,
    work_phone_number: a.workPhoneNumber,
    email_address: a.emailAddress,
    driver_license_expiration_date: a.driverLicenseExpirationDate,
    photo_url: a.photoUrl,
  };
}

export class WorkforceAssociateStore {
  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }

  async listAll(): Promise<WorkforceAssociate[]> {
    const { data, error } = await this.client
      .from('workforce_associates')
      .select('*')
      .order('full_name', { ascending: true });

    if (error) {
      console.error('WorkforceAssociateStore.listAll failed', error);
      return [];
    }
    return (data as AssociateRow[] | null)?.map(toAssociate) ?? [];
  }

  async getByTransporterIds(ids: string[]): Promise<Map<string, WorkforceAssociate>> {
    const map = new Map<string, WorkforceAssociate>();
    const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (unique.length === 0) return map;

    // Chunk to keep URLs/query size reasonable.
    const chunkSize = 200;
    for (let i = 0; i < unique.length; i += chunkSize) {
      const chunk = unique.slice(i, i + chunkSize);
      const { data, error } = await this.client
        .from('workforce_associates')
        .select('*')
        .in('transporter_id', chunk);

      if (error) {
        console.error('WorkforceAssociateStore.getByTransporterIds failed', error);
        continue;
      }
      for (const row of (data as AssociateRow[] | null) ?? []) {
        map.set(row.transporter_id, toAssociate(row));
      }
    }
    return map;
  }

  async upsertMany(associates: WorkforceAssociate[]): Promise<{ upserted: number }> {
    if (associates.length === 0) return { upserted: 0 };

    const syncedAt = new Date().toISOString();
    const rows = associates.map((a) => ({ ...toRow(a), synced_at: syncedAt }));
    const chunkSize = 100;
    let upserted = 0;

    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const { error, count } = await this.client
        .from('workforce_associates')
        .upsert(chunk, { onConflict: 'transporter_id', count: 'exact' });

      if (error) {
        throw new Error(`Failed to upsert workforce associates: ${error.message}`);
      }
      upserted += count ?? chunk.length;
    }

    return { upserted };
  }

  async latestSyncedAt(): Promise<string | null> {
    const { data, error } = await this.client
      .from('workforce_associates')
      .select('synced_at')
      .order('synced_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('WorkforceAssociateStore.latestSyncedAt failed', error);
      return null;
    }
    return (data as { synced_at?: string } | null)?.synced_at ?? null;
  }

  async count(): Promise<number> {
    const { count, error } = await this.client
      .from('workforce_associates')
      .select('*', { count: 'exact', head: true });

    if (error) {
      console.error('WorkforceAssociateStore.count failed', error);
      return 0;
    }
    return count ?? 0;
  }
}
