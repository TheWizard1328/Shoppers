import { offlineDB } from './offlineDatabase';
import { getOfflineStoreName, OFFLINE_SYNC_ENTITY_CLIENTS } from './offlineEntityRegistry';

const buildTempEntityId = (entityName) => `temp_${entityName.toLowerCase()}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

export const createGenericEntityLocal = async ({ entityName, entityData, mutationsPaused, notifyMutation }) => {
  if (mutationsPaused) {
    throw new Error('Mutations are paused during route optimization');
  }

  const Entity = OFFLINE_SYNC_ENTITY_CLIENTS[entityName];
  const storeName = getOfflineStoreName(offlineDB, entityName);
  if (!Entity || !storeName) {
    throw new Error(`Unsupported offline entity: ${entityName}`);
  }

  const { smartRefreshManager } = await import('./smartRefreshManager');
  smartRefreshManager.pause();

  try {
    const tempId = entityData.id || buildTempEntityId(entityName);
    const localRecord = {
      ...entityData,
      id: tempId,
      created_date: new Date().toISOString(),
      updated_date: new Date().toISOString(),
      _isLocal: true
    };

    await offlineDB.bulkSave(storeName, [localRecord]);
    notifyMutation({ type: 'create', entity: entityName, id: tempId, data: localRecord });

    try {
      const backendRecord = await Entity.create(entityData);
      await offlineDB.deleteRecord(storeName, tempId);
      await offlineDB.bulkSave(storeName, [backendRecord]);
      notifyMutation({ type: 'replace', entity: entityName, oldId: tempId, newId: backendRecord.id, data: backendRecord });
      smartRefreshManager.restart();
      return backendRecord;
    } catch {
      await offlineDB.addPendingMutation({
        operation: 'create',
        entity: entityName,
        recordId: tempId,
        payload: entityData
      });
      smartRefreshManager.restart();
      return localRecord;
    }
  } catch (error) {
    smartRefreshManager.restart();
    throw error;
  }
};

export const updateGenericEntityLocal = async ({ entityName, recordId, updates, mutationsPaused, notifyMutation }) => {
  if (mutationsPaused) {
    throw new Error('Mutations are paused during route optimization');
  }

  const Entity = OFFLINE_SYNC_ENTITY_CLIENTS[entityName];
  const storeName = getOfflineStoreName(offlineDB, entityName);
  if (!Entity || !storeName) {
    throw new Error(`Unsupported offline entity: ${entityName}`);
  }

  const { smartRefreshManager } = await import('./smartRefreshManager');
  smartRefreshManager.pause();

  try {
    const existingRecord = await offlineDB.getById(storeName, recordId);
    if (!existingRecord) {
      throw new Error(`${entityName} ${recordId} not found in local database`);
    }

    const updatedRecord = {
      ...existingRecord,
      ...updates,
      updated_date: new Date().toISOString()
    };

    await offlineDB.bulkSave(storeName, [updatedRecord]);
    notifyMutation({ type: 'update', entity: entityName, id: recordId, data: updatedRecord });

    try {
      await Entity.update(recordId, updates);
    } catch {
      await offlineDB.addPendingMutation({
        operation: 'update',
        entity: entityName,
        recordId,
        payload: updates
      });
    }

    smartRefreshManager.restart();
    return updatedRecord;
  } catch (error) {
    smartRefreshManager.restart();
    throw error;
  }
};

export const deleteGenericEntityLocal = async ({ entityName, recordId, mutationsPaused, notifyMutation }) => {
  if (mutationsPaused) {
    throw new Error('Mutations are paused during route optimization');
  }

  const Entity = OFFLINE_SYNC_ENTITY_CLIENTS[entityName];
  const storeName = getOfflineStoreName(offlineDB, entityName);
  if (!Entity || !storeName) {
    throw new Error(`Unsupported offline entity: ${entityName}`);
  }

  const { smartRefreshManager } = await import('./smartRefreshManager');
  smartRefreshManager.pause();

  try {
    await offlineDB.deleteRecord(storeName, recordId);
    notifyMutation({ type: 'delete', entity: entityName, id: recordId, data: null });

    try {
      await Entity.delete(recordId);
    } catch (error) {
      if (!(error.response?.status === 404 || error.message?.includes('404') || error.message?.includes('not found'))) {
        await offlineDB.addPendingMutation({
          operation: 'delete',
          entity: entityName,
          recordId
        });
      }
    }

    smartRefreshManager.restart();
    return true;
  } catch (error) {
    smartRefreshManager.restart();
    throw error;
  }
};