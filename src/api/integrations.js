import { base44 } from './base44Client';
import { trackIntegrationCall } from '@/components/utils/trackIntegrationCall';

export const InvokeLLM = (payload, tracking = {}) =>
  trackIntegrationCall({
    integrationName: 'Core',
    operationName: 'InvokeLLM',
    feature: tracking.feature || null,
    metadata: tracking.metadata || {},
    call: () => base44.integrations.Core.InvokeLLM(payload)
  });

export const SendEmail = (payload, tracking = {}) =>
  trackIntegrationCall({
    integrationName: 'Core',
    operationName: 'SendEmail',
    feature: tracking.feature || null,
    metadata: tracking.metadata || {},
    call: () => base44.integrations.Core.SendEmail(payload)
  });

export const SendSMS = (payload, tracking = {}) =>
  trackIntegrationCall({
    integrationName: 'Core',
    operationName: 'SendSMS',
    feature: tracking.feature || null,
    metadata: tracking.metadata || {},
    call: () => base44.integrations.Core.SendSMS(payload)
  });

export const UploadFile = (payload, tracking = {}) =>
  trackIntegrationCall({
    integrationName: 'Core',
    operationName: 'UploadFile',
    feature: tracking.feature || null,
    metadata: tracking.metadata || {},
    call: () => base44.integrations.Core.UploadFile(payload)
  });

export const GenerateImage = (payload, tracking = {}) =>
  trackIntegrationCall({
    integrationName: 'Core',
    operationName: 'GenerateImage',
    feature: tracking.feature || null,
    metadata: tracking.metadata || {},
    call: () => base44.integrations.Core.GenerateImage(payload)
  });

export const ExtractDataFromUploadedFile = (payload, tracking = {}) =>
  trackIntegrationCall({
    integrationName: 'Core',
    operationName: 'ExtractDataFromUploadedFile',
    feature: tracking.feature || null,
    metadata: tracking.metadata || {},
    call: () => base44.integrations.Core.ExtractDataFromUploadedFile(payload)
  });

export const Core = {
  ...base44.integrations.Core,
  InvokeLLM,
  SendEmail,
  SendSMS,
  UploadFile,
  GenerateImage,
  ExtractDataFromUploadedFile,
};