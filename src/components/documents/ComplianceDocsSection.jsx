import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { FileText, ShieldCheck, Lock, ScrollText, ExternalLink } from 'lucide-react';

// Public RxDeliver privacy/compliance documents (PDF).
// These are company-level policy documents viewable by all authenticated users.
const COMPLIANCE_DOCS = [
  {
    key: 'legal_review_cover_sheet',
    label: 'Legal Review Cover Sheet',
    description: 'Legal review cover sheet',
    icon: ScrollText,
    url: 'https://base44.app/api/apps/69ec8fbf8ec23374b47b361d/files/mp/public/69ec8fbf8ec23374b47b361d/1344aa31a_RxDeliver_Legal_Review_Cover_Sheet.pdf',
  },
  {
    key: 'pia_vendor_package',
    label: 'PIA Vendor Package v5.6',
    description: 'Privacy Impact Assessment — vendor package',
    icon: ShieldCheck,
    url: 'https://base44.app/api/apps/69ec8fbf8ec23374b47b361d/files/mp/public/69ec8fbf8ec23374b47b361d/f8b47e575_RxDeliver_PIA_Vendor_Package_v5_6.pdf',
  },
  {
    key: 'ima_template',
    label: 'IMA Template v2.5',
    description: 'Information Manager Agreement template',
    icon: FileText,
    url: 'https://base44.app/api/apps/69ec8fbf8ec23374b47b361d/files/mp/public/69ec8fbf8ec23374b47b361d/1b29ce129_RxDeliver_IMA_Template_v2_5.pdf',
  },
  {
    key: 'nda_template',
    label: 'NDA Template v5.5',
    description: 'Non-Disclosure Agreement template',
    icon: Lock,
    url: 'https://base44.app/api/apps/69ec8fbf8ec23374b47b361d/files/mp/public/69ec8fbf8ec23374b47b361d/e81d5e519_RxDeliver_NDA_Template_v5_5.pdf',
  },
];

export default function ComplianceDocsSection({ onView }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-blue-600" />
          Compliance &amp; Privacy Documents
        </CardTitle>
        <CardDescription>RxDeliver privacy and compliance documents</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          {COMPLIANCE_DOCS.map((doc) => {
            const Icon = doc.icon;
            return (
              <div key={doc.key} className="flex items-center gap-2 p-3 border rounded-lg text-sm">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 bg-blue-100 dark:bg-blue-900/40">
                    <Icon className="w-3.5 h-3.5 text-blue-600 dark:text-blue-300" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold truncate">{doc.label}</p>
                    <p className="text-xs text-muted-foreground truncate">{doc.description}</p>
                  </div>
                </div>
                <span
                  onClick={() => onView(doc)}
                  className="cursor-pointer text-xs font-medium px-2.5 py-1 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/60 transition-colors flex-shrink-0 flex items-center gap-1">
                  <ExternalLink className="w-3 h-3" /> View
                </span>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}