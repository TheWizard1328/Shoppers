import { base44 } from '@/api/base44Client';
import { matchPatientFromIDB } from '../utils/patientMatchIDB';

export const compressImage = (file, maxWidth = 1600, quality = 0.85) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = (event) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let width = img.width;
      let height = img.height;

      if (width > maxWidth) {
        height = height * maxWidth / width;
        width = maxWidth;
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Failed to compress image'));
          return;
        }

        resolve(new File([blob], file.name, {
          type: 'image/jpeg',
          lastModified: Date.now()
        }));
      }, 'image/jpeg', quality);
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = event.target.result;
  };
  reader.onerror = () => reject(new Error('Failed to read file'));
  reader.readAsDataURL(file);
});

/**
 * Scan a prescription label image.
 * Backend does LLM extraction ONLY. Patient matching is done client-side
 * against IndexedDB using matchPatientFromIDB.
 *
 * @param {object} options - { file, mode, appUser, activePickupStoreIds, nearestStoreId }
 */
export const scanPrescriptionLabel = async ({ file, mode = 'fileUrl', appUser, activePickupStoreIds, nearestStoreId }) => {
  const compressedFile = await compressImage(file);

  let extractedData;

  if (mode === 'base64') {
    const reader = new FileReader();
    const base64Image = await new Promise((resolve, reject) => {
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(compressedFile);
    });

    const response = await base44.functions.invoke('scanPrescriptionLabel', { base64Image });
    extractedData = response?.data?.extractedData || response?.extractedData;
  } else {
    const uploadResult = await base44.integrations.Core.UploadFile({ file: compressedFile });
    const response = await base44.functions.invoke('scanPrescriptionLabel', { fileUrl: uploadResult.file_url });
    extractedData = response?.data?.extractedData || response?.extractedData;
  }

  if (!extractedData) {
    throw new Error('LLM extraction returned no data');
  }

  console.log('[scanPrescriptionLabel] LLM extracted:', extractedData);

  // Client-side matching against IDB
  const matchResult = await matchPatientFromIDB(extractedData, {
    appUser,
    activePickupStoreIds: activePickupStoreIds || [],
    nearestStoreId: nearestStoreId || null,
  });

  return matchResult;
};

export const handlePrescriptionScanResult = async ({
  result,
  onCreatePatient,
  handlePatientSelect,
  setScanMatches,
  setShowMatchPopup,
  setExtractedData,
  setIsPatientFormOpen
}) => {
  if (result.error) {
    throw new Error(result.error);
  }

  setExtractedData(result.extractedData);

  if (result.exactMatches && result.exactMatches.length === 1) {
    await handlePatientSelect(result.exactMatches[0].patient, false);
    return;
  }

  if (result.exactMatches && result.exactMatches.length > 1) {
    setScanMatches(result.exactMatches);
    setShowMatchPopup(true);
    return;
  }

  if (result.matches && result.matches.length > 0) {
    setScanMatches(result.matches);
    setShowMatchPopup(true);
    return;
  }

  if (onCreatePatient) {
    const newPatientData = {
      full_name: result.extractedData.patient_name,
      address: result.extractedData.street_address,
      phone: result.extractedData.phone_number,
      _isNew: true
    };

    setIsPatientFormOpen(true);
    onCreatePatient((createdPatient) => {
      setIsPatientFormOpen(false);
      handlePatientSelect({
        ...createdPatient,
        ...newPatientData
      }, true);
    }, newPatientData);
  }
};
