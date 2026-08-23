import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // Check if templates already exist
    const existing = await base44.asServiceRole.entities.ComplianceDocument.filter({ status: 'template' });
    if (existing && existing.length > 0) {
      return Response.json({ 
        success: true, 
        message: 'Templates already exist',
        count: existing.length 
      });
    }
    
    // Create the 4 template records
    const templates = [
      {
        document_type: 'legal_cover_sheet',
        title: 'Legal Review Cover Sheet',
        status: 'template',
        version: 'v1.0',
        file_url: 'https://base44.app/api/apps/69f0c6983e41b169cdc3be5b/files/mp/public/69f0c6983e41b169cdc3be5b/619d9dd7b_RxDeliver_Legal_Review_Cover_Sheet.pdf',
        mime_type: 'application/pdf',
        covered_store_ids: [],
      },
      {
        document_type: 'PIA',
        title: 'PIA Vendor Package',
        status: 'template',
        version: 'v5.6',
        file_url: 'https://base44.app/api/apps/69f0c6983e41b169cdc3be5b/files/mp/public/69f0c6983e41b169cdc3be5b/54ffa5fe4_RxDeliver_PIA_Vendor_Package_v5_6.pdf',
        mime_type: 'application/pdf',
        covered_store_ids: [],
      },
      {
        document_type: 'IMA',
        title: 'Information Manager Agreement (IMA) Template',
        status: 'template',
        version: 'v2.5',
        file_url: 'https://base44.app/api/apps/69f0c6983e41b169cdc3be5b/files/mp/public/69f0c6983e41b169cdc3be5b/191e68892_RxDeliver_IMA_Template_v2_5.pdf',
        mime_type: 'application/pdf',
        covered_store_ids: [],
      },
      {
        document_type: 'NDA',
        title: 'Non-Disclosure Agreement (NDA) Template',
        status: 'template',
        version: 'v5.5',
        file_url: 'https://base44.app/api/apps/69f0c6983e41b169cdc3be5b/files/mp/public/69f0c6983e41b169cdc3be5b/fb2a8403a_RxDeliver_NDA_Template_v5_5.pdf',
        mime_type: 'application/pdf',
        covered_store_ids: [],
      },
    ];
    
    const created = [];
    for (const tmpl of templates) {
      const record = await base44.asServiceRole.entities.ComplianceDocument.create(tmpl);
      created.push({ id: record.id, document_type: tmpl.document_type, title: tmpl.title });
    }
    
    return Response.json({ 
      success: true, 
      message: 'Templates created',
      count: created.length,
      templates: created
    });
  } catch (error) {
    console.error('Error seeding compliance templates:', error);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});
