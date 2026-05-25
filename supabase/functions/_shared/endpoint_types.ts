import type { WebhookError } from "./webhook_types.ts";
import type {
  ContactsMessage,
  LocationMessage,
  OutgoingAudio,
  OutgoingContextInfo,
  OutgoingDocument,
  OutgoingImage,
  OutgoingReaction,
  OutgoingSticker,
  OutgoingText,
  OutgoingVideo,
  TemplateMessage,
} from "./message_types.ts";

// Message format sent to the WhatsApp endpoint
// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
export type EndpointMessage =
  & {
    biz_opaque_callback_data?: string;
    messaging_product: "whatsapp";
    recipient_type?: "individual";
    to: string;
  }
  & OutgoingContextInfo
  & (
    | OutgoingAudio
    | ContactsMessage
    | OutgoingDocument
    | OutgoingImage
    | LocationMessage
    | OutgoingReaction
    | OutgoingSticker
    | TemplateMessage
    | OutgoingText
    | OutgoingVideo
  );

export type EndpointMessageResponse = {
  messaging_product: "whatsapp";
  contacts: [
    {
      input: string;
      wa_id: string;
    },
  ];
  messages: [
    {
      id: string;
      group_id?: string;
      message_status?: "accepted" | "held_for_quality_assessment";
    },
  ];
};

//===================================
// Statuses
//===================================

/** STATUS
 *
 * 1. Sent messages
 *    WebhookStatus -> OutgoingStatus
 *
 * 2. Received messages
 *    IncomingStatus -> EndpointStatus
 */

export type IncomingStatus = {
  pending?: string; // new Date().toISOString()
  read?: string;
  typing?: string;
  preprocessing?: string;
  preprocessed?: string;
};

export type OutgoingStatus = {
  pending?: string; // new Date().toISOString()
  held_for_quality_assessment?: string;
  accepted?: string;
  sent?: string;
  delivered?: string;
  read?: string;
  failed?: string;
  preprocessing?: string;
  preprocessed?: string;
  errors?: WebhookError[];
};

export type EndpointStatus = {
  messaging_product: "whatsapp";
  status: "read";
  message_id: string;
  typing_indicator?: {
    type: "text";
  };
};

export type EndpointStatusResponse = {
  success: true;
};
