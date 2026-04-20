import { offlineDB } from '@/components/utils/offlineDatabase';
import { Patient } from '@/entities/Patient';
import { Delivery } from '@/entities/Delivery';
import { AppUser } from '@/entities/AppUser';
import { City } from '@/entities/City';
import { Store } from '@/entities/Store';
import { Company } from '@/entities/Company';
import {
  fetchAppUsersDedup,
  fetchDeliveriesDedup,
  fetchPatientsDedup,
  fetchCitiesDedup,
  fetchStoresDedup,
  invalidateEntityCache
} from '@/components/utils/dataSyncCoordinator';

export const offlineSyncDeps = {
  offlineDB,
  Patient,
  Delivery,
  AppUser,
  City,
  Store,
  Company,
  fetchAppUsersDedup,
  fetchDeliveriesDedup,
  fetchPatientsDedup,
  fetchCitiesDedup,
  fetchStoresDedup,
  invalidateEntityCache
};