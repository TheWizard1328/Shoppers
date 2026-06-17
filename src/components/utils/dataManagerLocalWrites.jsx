import {
  createPatientLocal,
  updatePatientLocal,
  deletePatientLocal,
  createDeliveryLocal,
  updateDeliveryLocal,
  deleteDeliveryLocal,
  batchCreateDeliveriesLocal,
  createCityLocal,
  updateCityLocal,
  deleteCityLocal,
  createStoreLocal,
  updateStoreLocal,
  deleteStoreLocal,
  createCompanyLocal,
  updateCompanyLocal,
  deleteCompanyLocal,
  subscribeMutations
} from './offlineMutations';

export const localWrites = {
  createPatient: createPatientLocal,
  updatePatient: updatePatientLocal,
  deletePatient: deletePatientLocal,
  createDelivery: createDeliveryLocal,
  updateDelivery: updateDeliveryLocal,
  deleteDelivery: deleteDeliveryLocal,
  batchCreateDeliveries: batchCreateDeliveriesLocal,
  createCity: createCityLocal,
  updateCity: updateCityLocal,
  deleteCity: deleteCityLocal,
  createStore: createStoreLocal,
  updateStore: updateStoreLocal,
  deleteStore: deleteStoreLocal,
  createCompany: createCompanyLocal,
  updateCompany: updateCompanyLocal,
  deleteCompany: deleteCompanyLocal,
  subscribeMutations
};