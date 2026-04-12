import Patient from '@/entities/Patient.json';
import Delivery from '@/entities/Delivery.json';
import AppUser from '@/entities/AppUser.json';
import City from '@/entities/City.json';
import Store from '@/entities/Store.json';
import Company from '@/entities/Company.json';

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