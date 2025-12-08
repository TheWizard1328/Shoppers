import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { fileUrl, selectedCityId } = body;

    if (!fileUrl) {
      return Response.json({ error: 'No image URL provided' }, { status: 400 });
    }

    console.log('📸 [scanPrescriptionLabel] Processing image:', fileUrl);

    // Extract data using OCR
    console.log('🔍 [scanPrescriptionLabel] Extracting data from image...');
    const extractionResult = await base44.integrations.Core.ExtractDataFromUploadedFile({
      file_url: fileUrl,
      json_schema: {
        type: "object",
        properties: {
          patient_name: { type: "string" },
          street_address: { type: "string" },
          city_state_zip: { type: "string" },
          phone_number: { type: "string" }
        },
        required: ["patient_name", "street_address", "phone_number"]
      }
    });

    console.log('📊 [scanPrescriptionLabel] Extraction result:', extractionResult);

    if (extractionResult.status !== 'success' || !extractionResult.output) {
      console.error('❌ [scanPrescriptionLabel] Extraction failed:', extractionResult);
      return Response.json({ 
        error: 'Failed to extract data from image',
        details: extractionResult.details 
      }, { status: 400 });
    }

    const extractedData = extractionResult.output;
    console.log('✅ [scanPrescriptionLabel] Extracted data:', extractedData);

    // Now search for matching patients
    // Get user's role and store access
    console.log('👤 [scanPrescriptionLabel] Fetching user roles...');
    const appUsers = await base44.entities.AppUser.filter({ user_id: user.id });
    const appUser = appUsers[0];

    if (!appUser) {
      console.error('❌ [scanPrescriptionLabel] AppUser not found for user:', user.id);
      return Response.json({ error: 'User not found' }, { status: 404 });
    }

    const isAdmin = appUser.app_roles?.includes('admin');
    const isDispatcher = appUser.app_roles?.includes('dispatcher');
    const isDriver = appUser.app_roles?.includes('driver');
    console.log('✅ [scanPrescriptionLabel] User roles:', { isAdmin, isDispatcher, isDriver });

    // Build patient filter based on role
    let patientFilter = {};

    if (isAdmin) {
      // Get all stores in the selected city (from request)
      if (selectedCityId) {
        console.log('🏙️ [scanPrescriptionLabel] Admin mode - filtering by city:', selectedCityId);
        const stores = await base44.asServiceRole.entities.Store.filter({ city_id: selectedCityId });
        const storeIds = stores.map(s => s.id);
        console.log('🏪 [scanPrescriptionLabel] Found stores in city:', storeIds.length);
        if (storeIds.length > 0) {
          patientFilter.store_id = { $in: storeIds };
        }
      }
    } else if (isDispatcher || isDriver) {
      // Filter to user's assigned stores
      const storeIds = appUser.store_ids || [];
      console.log('🏪 [scanPrescriptionLabel] Dispatcher/Driver mode - filtering by stores:', storeIds);
      if (storeIds.length > 0) {
        patientFilter.store_id = { $in: storeIds };
      }
    }

    // Get all patients matching the filter
    console.log('🔍 [scanPrescriptionLabel] Fetching patients with filter:', patientFilter);
    const allPatients = await base44.entities.Patient.filter(patientFilter);
    console.log('✅ [scanPrescriptionLabel] Found', allPatients.length, 'patients to search');

    // Fuzzy matching function
    const calculateMatch = (patient, extracted) => {
      let score = 0;
      let maxScore = 0;

      // Name matching (weight: 40%)
      maxScore += 40;
      const patientName = (patient.full_name || '').toLowerCase().trim();
      const extractedName = (extracted.patient_name || '').toLowerCase().trim();
      if (patientName === extractedName) {
        score += 40;
      } else if (patientName.includes(extractedName) || extractedName.includes(patientName)) {
        score += 30;
      } else {
        const nameWords = extractedName.split(/\s+/);
        const patientWords = patientName.split(/\s+/);
        const matchedWords = nameWords.filter(word => 
          patientWords.some(pw => pw.includes(word) || word.includes(pw))
        );
        score += (matchedWords.length / nameWords.length) * 40;
      }

      // Address matching (weight: 35%)
      maxScore += 35;
      const patientAddress = (patient.address || '').toLowerCase().trim();
      const extractedAddress = (extracted.street_address || '').toLowerCase().trim();
      if (patientAddress.includes(extractedAddress) || extractedAddress.includes(patientAddress)) {
        score += 35;
      } else {
        const addressWords = extractedAddress.split(/\s+/).filter(w => w.length > 2);
        const patientAddressWords = patientAddress.split(/\s+/);
        const matchedWords = addressWords.filter(word => 
          patientAddressWords.some(pw => pw.includes(word) || word.includes(pw))
        );
        if (addressWords.length > 0) {
          score += (matchedWords.length / addressWords.length) * 35;
        }
      }

      // Phone matching (weight: 25%)
      maxScore += 25;
      const patientPhone = (patient.phone || '').replace(/\D/g, '');
      const extractedPhone = (extracted.phone_number || '').replace(/\D/g, '');
      if (patientPhone === extractedPhone) {
        score += 25;
      } else if (patientPhone.includes(extractedPhone) || extractedPhone.includes(patientPhone)) {
        score += 15;
      }

      // City/State/Zip bonus (weight: +10% if matches)
      if (extracted.city_state_zip) {
        const cityStateZip = extracted.city_state_zip.toLowerCase();
        if (patientAddress.includes(cityStateZip) || cityStateZip.includes(patientAddress)) {
          score += 10;
        }
      }

      return (score / maxScore) * 100;
    };

    // Calculate match scores for all patients
    console.log('🧮 [scanPrescriptionLabel] Calculating match scores...');
    const patientsWithScores = allPatients.map(patient => ({
      patient,
      score: calculateMatch(patient, extractedData)
    })).filter(item => item.score >= 60) // Only keep matches above 60%
      .sort((a, b) => b.score - a.score);

    console.log('✅ [scanPrescriptionLabel] Found', patientsWithScores.length, 'matches above 60%');
    if (patientsWithScores.length > 0) {
      console.log('   Top matches:', patientsWithScores.slice(0, 3).map(m => ({
        name: m.patient.full_name,
        score: Math.round(m.score)
      })));
    }

    return Response.json({
      extractedData,
      matches: patientsWithScores.map(item => ({
        patient: item.patient,
        matchScore: Math.round(item.score)
      }))
    });

  } catch (error) {
    console.error('Error in scanPrescriptionLabel:', error);
    return Response.json({ 
      error: error.message || 'Internal server error'
    }, { status: 500 });
  }
});