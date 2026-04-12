import { base44 } from '@/api/base44Client';

const Patient = base44.entities.Patient;
const Delivery = base44.entities.Delivery;
const AppUser = base44.entities.AppUser;
const City = base44.entities.City;
const Store = base44.entities.Store;
const Company = base44.entities.Company;

export const OFFLINE_ENTITY_STORE_KEYS = {
  Patient: 'PATIENTS',
  Delivery: 'DELIVERIES',
  AppUser: 'APP_USERS',
  City: 'CITIES',
  Store: 'STORES',
  Company: 'COMPANIES'
};

export const OFFLINE_SYNC_ENTITY_CLIENTS = {
  Patient,
  Delivery,
  AppUser,
  City,
  Store,
  Company
};

export const OFFLINE_MUTATION_ENTITY_NAMES = ['Patient', 'Delivery', 'City', 'Store', 'Company'];

export const getOfflineStoreName = (offlineDB, entityName) => {
  const storeKey = OFFLINE_ENTITY_STORE_KEYS[entityName];
  return storeKey ? offlineDB.STORES[storeKey] : null;
};

export const isOfflineManagedEntity = (entityName) => Boolean(OFFLINE_ENTITY_STORE_KEYS[entityName]);