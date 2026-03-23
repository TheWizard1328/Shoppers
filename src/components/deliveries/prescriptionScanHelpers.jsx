import { base44 } from '@/api/base44Client';

export const compressImage = (file, maxWidth = 1200, quality = 0.7) => new Promise((resolve, reject) => {
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

export const scanPrescriptionLabel = async ({ file, mode = 'fileUrl' }) => {
  const compressedFile = await compressImage(file);
  const { globalFilters } = await import('../utils/globalFilters');
  const selectedCityId = globalFilters.getSelectedCityId();

  if (mode === 'base64') {
    const reader = new FileReader();
    const base64Image = await new Promise((resolve, reject) => {
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(compressedFile);
    });

    const response = await base44.functions.invoke('scanPrescriptionLabel', {
      base64Image,
      selectedCityId
    });

    return response?.data || response;
  }

  const uploadResult = await base44.integrations.Core.UploadFile({ file: compressedFile });
  const response = await base44.functions.invoke('scanPrescriptionLabel', {
    fileUrl: uploadResult.file_url,
    selectedCityId
  });

  return response?.data || response;
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