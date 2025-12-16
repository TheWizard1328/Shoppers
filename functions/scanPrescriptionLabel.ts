import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { base64Image, fileUrl, selectedCityId } = body;

    if (!base64Image && !fileUrl) {
      return Response.json({ error: 'No image data provided' }, { status: 400 });
    }

    // Use fileUrl if provided, otherwise use base64Image
    const imageSource = fileUrl || base64Image;

    console.log('📸 [scanPrescriptionLabel] Processing image...');

    // Extract data using Vision LLM
    console.log('🔍 [scanPrescriptionLabel] Extracting data from image using Vision LLM...');
    const extractionResult = await base44.integrations.Core.InvokeLLM({
      prompt: "From the image of the prescription label, extract the patient's full name, street address, city, state, zip code, and phone number. If a piece of information is not present or clearly readable, return it as null. Focus only on information directly related to the patient's delivery address and contact.",
      response_json_schema: {
        type: "object",
        properties: {
          patient_name: { type: "string" },
          street_address: { type: "string" },
          city: { type: "string" },
          state: { type: "string" },
          zip_code: { type: "string" },
          phone_number: { type: "string" }
        }
      },
      file_urls: [imageSource]
    });

    console.log('📊 [scanPrescriptionLabel] LLM extraction result:', extractionResult);

    // Check if the LLM returned usable data
    if (!extractionResult || !extractionResult.patient_name) {
      console.error('❌ [scanPrescriptionLabel] LLM extraction failed or no patient name extracted');
      return Response.json({ 
        error: 'Failed to extract data from image. Please ensure the label is clear and readable.',
        details: 'No relevant data found'
      }, { status: 400 });
    }

    // Construct extractedData from LLM response
    const extractedData = {
      patient_name: extractionResult.patient_name,
      street_address: extractionResult.street_address,
      city_state_zip: [extractionResult.city, extractionResult.state, extractionResult.zip_code].filter(Boolean).join(', '),
      phone_number: extractionResult.phone_number
    };
    console.log('✅ [scanPrescriptionLabel] Extracted data from LLM:', extractedData);

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

    // Normalize address for exact matching (ignore street type variations)
    const normalizeAddress = (address) => {
      return address
        .toLowerCase()
        .trim()
        .replace(/\b(avenue|ave|street|st|road|rd|drive|dr|boulevard|blvd|lane|ln)\b/gi, '')
        .replace(/\b(nw|ne|sw|se|north|south|east|west)\b/gi, '')
        .replace(/[,\-\.]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    };

    // Check for exact match
    const isExactMatch = (patient, extracted) => {
      const patientName = (patient.full_name || '').toLowerCase().trim();
      const extractedName = (extracted.patient_name || '').toLowerCase().trim();
      const nameMatch = patientName === extractedName;

      const patientPhone = (patient.phone || '').replace(/\D/g, '');
      const extractedPhone = (extracted.phone_number || '').replace(/\D/g, '');
      const phoneMatch = patientPhone && extractedPhone && patientPhone === extractedPhone;

      const patientAddressNorm = normalizeAddress(patient.address || '');
      const extractedAddressNorm = normalizeAddress(extracted.street_address || '');
      const addressMatch = patientAddressNorm && extractedAddressNorm && patientAddressNorm === extractedAddressNorm;

      // Exact match requires name + (address OR phone)
      return nameMatch && (addressMatch || phoneMatch);
    };

    // Fuzzy matching function
    const calculateMatch = (patient, extracted) => {
      // Check for exact match first
      if (isExactMatch(patient, extracted)) {
        return 100;
      }

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

      // Address matching (weight: 35%) - use normalized addresses
      maxScore += 35;
      const patientAddressNorm = normalizeAddress(patient.address || '');
      const extractedAddressNorm = normalizeAddress(extracted.street_address || '');
      
      if (patientAddressNorm === extractedAddressNorm) {
        score += 35;
      } else if (patientAddressNorm.includes(extractedAddressNorm) || extractedAddressNorm.includes(patientAddressNorm)) {
        score += 28;
      } else {
        const addressWords = extractedAddressNorm.split(/\s+/).filter(w => w.length > 2);
        const patientAddressWords = patientAddressNorm.split(/\s+/);
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

    // Separate exact matches (100%) from partial matches
    const exactMatches = patientsWithScores.filter(item => item.score === 100);
    const partialMatches = patientsWithScores.filter(item => item.score < 100);

    console.log(`📊 [scanPrescriptionLabel] Exact matches: ${exactMatches.length}, Partial matches: ${partialMatches.length}`);

    return Response.json({
      extractedData,
      exactMatches: exactMatches.map(item => ({
        patient: item.patient,
        matchScore: 100
      })),
      matches: partialMatches.map(item => ({
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