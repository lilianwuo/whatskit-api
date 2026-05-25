import type { WebhookError } from "./webhook_types.ts";
import type { TaskState } from "./a2a_types.ts";
import type { Json } from "./db_types.ts";

//===================================
// Webhook Message, as received from WhatsApp
//===================================

export type SystemMessage = {
  type: "system";
  system: {
    body: string; // Describes the change to the user's phone number.
    type: "user_changed_number";
    wa_id: string; // New WhatsApp ID for the user when their phone number is updated.
  };
};

export type UnsupportedMessage = {
  type: "unsupported";
  errors: Omit<WebhookError, "href">[];
  unsupported: {
    type: "edit" | "poll" | "button";
  };
};

export type ErrorsMessage = {
  errors: Omit<WebhookError, "href">[];
  type: "errors";
};

// Shared types

// Only included when a user replies or interacts with one of your messages.
export type IncomingContextInfo = {
  context?: {
    forwarded?: boolean;
    frequently_forwarded?: boolean;
    from?: string; // The WhatsApp ID for the customer who replied to an inbound message.
    id?: string; //  The message ID for the sent message for an inbound reply.
    referred_product?: {
      catalog_id: string;
      product_retailer_id: string;
    };
  };
};

/** Present in types:
 * - text
 * - location
 * - contact
 * - image
 * - video
 * - document
 * - audio
 * - sticker
 */
export type ReferralInfo = {
  referral?:
    & {
      source_url: string;
      source_type: "ad" | "post";
      source_id: string;
      headline: string;
      body: string;
      ctwa_clid?: string; // The ctwa_clid property is omitted entirely for messages originating from an ad in WhatsApp Status
      welcome_message: {
        text: string;
      };
    }
    & (
      | {
        media_type: "image";
        image_url: string;
      }
      | {
        media_type: "video";
        video_url: string;
        thumbnail_url?: string;
      }
    );
};

// Text based

export type TextMessage = {
  type: "text";
  text: {
    body: string;
  };
} & ReferralInfo;

export type ReactionMessage = {
  type: "reaction";
  reaction: {
    message_id: string;
    emoji?: string;
  };
};

// File based

export type AudioMessage = {
  type: "audio";
  audio: {
    id: string;
    mime_type:
      | "audio/aac"
      | "audio/amr"
      | "audio/mpeg"
      | "audio/mp4"
      | "audio/ogg; codecs=opus";
    voice: boolean;
  };
} & ReferralInfo;

export type ImageMessage = {
  type: "image";
  image: {
    id: string;
    mime_type: "image/jpeg" | "image/png" | "image/webp";
    sha256: string;
    caption?: string;
  };
} & ReferralInfo;

export type VideoMessage = {
  type: "video";
  video: {
    id: string;
    mime_type: "video/3gp" | "video/mp4";
    sha256: string;
    caption?: string;
    filename: string;
  };
} & ReferralInfo;

export type DocumentMessage = {
  type: "document";
  document: {
    caption?: string;
    filename: string;
    id: string;
    sha256: string;
    mime_type:
      | "text/plain"
      | "application/vnd.ms-excel"
      | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      | "application/msword"
      | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      | "application/vnd.ms-powerpoint"
      | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      | "application/pdf";
  };
} & ReferralInfo;

export type StickerMessage = {
  type: "sticker";
  sticker: {
    id: string;
    mime_type: "image/webp";
    sha256: string;
    animated: boolean;
  };
} & ReferralInfo;

export type MediaPlaceholder = { type: "media_placeholder" };

// Data based

// This message type is produced when the user interacts with a template message button.
export type ButtonMessage = {
  type: "button";
  button: {
    text: string;
    payload: string;
  };
};

// This message type is produced when the user interacts with an interactive message button or list option.
export type InteractiveMessage = {
  type: "interactive";
  interactive:
    | { type: "button_reply"; button_reply: { id: string; title: string } }
    | {
      type: "list_reply";
      list_reply: { id: string; title: string; description?: string };
    };
};

// ORDER

export type Order = {
  catalog_id: string;
  product_items: {
    product_retailer_id: string;
    quantity: string;
    item_price: string;
    currency: string;
  }[];
  text: string;
};

export type OrderMessage = {
  type: "order";
  order: Order;
};

// CONTACTS

export type Contact = {
  name: {
    first_name?: string;
    formatted_name: string;
    last_name?: string;
    middle_name?: string;
    suffix?: string;
    prefix?: string;
  };
  phones?: {
    phone: string;
    type: string;
    wa_id?: string;
  }[];
};

export type ContactsMessage = {
  type: "contacts";
  contacts: Contact[];
} & ReferralInfo;

// LOCATION

export type Location = {
  address: string;
  latitude: number;
  longitude: number;
  name: string;
  url?: string;
};

export type LocationMessage = {
  type: "location";
  location: Location;
} & ReferralInfo;

// Message format received from the WhatsApp webhook
// https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
export type HistoryContext = {
  status: "sent" | "delivered" | "read" | "failed";
};

export type WebhookMessageBase =
  & {
    from: string;
    group_id?: string;
    id: string;
    timestamp: number;
  }
  & (
    | AudioMessage
    | ButtonMessage
    | ContactsMessage
    | DocumentMessage
    | ErrorsMessage
    | ImageMessage
    | InteractiveMessage
    | LocationMessage
    | OrderMessage
    | ReactionMessage
    | StickerMessage
    | SystemMessage
    | TextMessage
    | UnsupportedMessage
    | VideoMessage
    | MediaPlaceholder
  );

//===================================
// Outgoing message, as stored in the database
//===================================

export type OutgoingContextInfo = {
  context?: { message_id: string };
};

// Outgoing message parameter types (defined here to support TemplateParameter without circular imports)

export type OutgoingText = {
  type: "text";
  text: {
    body: string;
    preview_url?: boolean;
  };
};

export type OutgoingReaction = {
  type: "reaction";
  reaction: {
    emoji: string;
    message_id: string;
  };
};

export type OutgoingAudio = {
  type: "audio";
  audio: ({ id: string } | { link: string }) & { voice?: boolean };
};

export type OutgoingImage = {
  type: "image";
  image: ({ id: string } | { link: string }) & { caption?: string };
};

export type OutgoingVideo = {
  type: "video";
  video: ({ id: string } | { link: string }) & { caption?: string };
};

export type OutgoingDocument = {
  type: "document";
  document: ({ id: string } | { link: string }) & {
    caption?: string;
    filename?: string;
  };
};

export type OutgoingSticker = {
  type: "sticker";
  sticker: { id: string } | { link: string };
};

// TEMPLATE

// Template data, used to create or update a template message

export type TemplateData = {
  id: string;
  name: string;
  status:
    | "APPROVED"
    | "IN_APPEAL"
    | "PENDING"
    | "REJECTED"
    | "PENDING_DELETION"
    | "DELETED"
    | "DISABLED"
    | "PAUSED"
    | "LIMIT_EXCEEDED";
  category: "MARKETING"; // TODO: service and auth categories - cabra 2024/09/12
  language: string;
  components: (
    | BodyComponent
    | HeaderComponent
    | FooterComponent
    | ButtonsComponent
  )[];
  sub_category: "CUSTOM";
};

type HeaderComponent = {
  type: "HEADER";
  text: string;
  format: "TEXT"; // TODO: other formats such as image - cabra 2024/09/12
  example?: {
    header_text: [string];
  };
};

type BodyComponent = {
  type: "BODY";
  text: string;
  example?: {
    body_text: [string[]];
  };
};

type FooterComponent = {
  type: "FOOTER";
  text: string;
};

type ButtonsComponent = {
  type: "BUTTONS";
  buttons: QuickReply[]; // TODO: call to action buttons - cabra 2024/09/12
};

type QuickReply = {
  type: "QUICK_REPLY";
  text: string;
};

// Template message, used to send a template message

type CurrencyParameter = {
  type: "currency";
  currency: {
    fallback_value: string;
    code: string; // ISO 4217
    amount_1000: number;
  };
};

type DateTimeParameter = {
  type: "date_time";
  date_time: {
    fallback_value: string;
    // localization is not attempted by Cloud API, fallback_value is always used
  };
};

type TextParameter = {
  type: "text";
  text: string;
};

export type TemplateParameter =
  | CurrencyParameter
  | DateTimeParameter
  | TextParameter
  | OutgoingImage
  | OutgoingVideo
  | OutgoingDocument;

type TemplateHeader = {
  type: "header";
  parameters?: TemplateParameter[];
};

type TemplateBody = {
  type: "body";
  parameters?: TemplateParameter[];
};

type TemplateButton =
  & {
    type: "button";
    index: string; // 0-9
  }
  & (
    | {
      sub_type: "quick_reply";
      parameters: {
        type: "payload";
        payload: string;
      }[];
    }
    | {
      sub_type: "url";
      parameters: {
        type: "url";
        text: string;
      }[];
    }
  );

export type Template = {
  components?: (TemplateHeader | TemplateBody | TemplateButton)[];
  language: {
    code: string; // es, es_AR, etc
    policy: "deterministic";
  };
  name: string;
};

export type TemplateMessage = {
  type: "template";
  template: Template;
};

// TODO: InteractiveMessage

//===================================
// Agent Protocol Types
//===================================

// The same message can be a task request and a task response.
// A user message is a task request. The message produced by an agent is a task response.
// Then, for example, another agent might react to that message, creating a new task request.
// The message is now a task response and a task request.
export type TaskInfo = {
  task?: {
    id: string;
    status?: TaskState;
    session_id?: string;
  };
};

export type ToolInfo = {
  tool?:
    & ToolEventInfo
    & (LocalToolInfo | GoogleToolInfo | OpenAIToolInfo | AnthropicToolInfo);
};

export type ToolEventInfo =
  | { use_id: string; event: "use" }
  | { use_id: string; event: "result"; is_error?: boolean };

type LocalSimpleToolInfo = {
  provider: "local";
  type: "function" | "custom";
  name: string;
};

type LocalSpecialToolInfo = {
  provider: "local";
  type: "mcp" | "sql" | "http";
  label: string;
  name: string;
};

export type LocalToolInfo = LocalSimpleToolInfo | LocalSpecialToolInfo;

type GoogleToolInfo = {
  provider: "google";
  type: "google_search" | "code_execution" | "url_context";
};

type OpenAIToolInfo = {
  provider: "openai";
  type:
    | "mcp"
    | "web_search_preview"
    | "file_search"
    | "image_generation"
    | "code_interpreter"
    | "computer_use_preview";
};

type AnthropicToolInfo = {
  provider: "anthropic";
  type:
    | "mcp"
    | "bash"
    | "code_execution"
    | "computer"
    | "str_replace_based_edit_tool"
    | "web_search";
};

// Text based

export type TextPart = {
  type: "text";
  kind: "text" | "reaction" | "caption" | "transcription" | "description";
  text: string;
  artifacts?: Part[];
};

// File based

export const MediaTypes = [
  "audio",
  "image",
  "video",
  "document",
  "sticker",
] as const;

/**
 * Represents a file, such as an image, video, or document.
 * WhatsApp allows media messages to include an accompanying text caption.
 * For now, this caption is embedded directly within the `text` attribute of the `FilePart`.
 * A more structured approach, leveraging the `Parts` type, would involve separate
 * `FilePart` and `TextPart` components for such messages in the future.
 */
export type FilePart = {
  type: "file";
  kind: (typeof MediaTypes)[number];
  file: {
    mime_type: string;
    uri: string; // --> internal://media/organizations/${organization_id}/attachments/${file_hash}
    name?: string;
    size: number;
  };
  text?: string; // caption
  artifacts?: Part[];
};

// Data based

export type DataPart<Kind = "data", T = Json> = {
  type: "data";
  kind: Kind;
  data: T;
  text?: string;
  artifacts?: Part[];
};

type ContactsPart = DataPart<"contacts", Contact[]>;

type LocationPart = DataPart<"location", Location>;

type OrderPart = DataPart<"order", Order>;

type InteractivePart = DataPart<
  "interactive",
  InteractiveMessage["interactive"]
>;

type ButtonPart = DataPart<"button", ButtonMessage["button"]>;

type TemplatePart = DataPart<"template", Template>;

type MediaPlaceholderPart = DataPart<
  "media_placeholder",
  Record<PropertyKey, never>
>;

type UnsupportedPart = DataPart<
  "unsupported",
  UnsupportedMessage["unsupported"]
>;

// Multi-part messages

export type Part = TextPart | DataPart | FilePart;

// Parts type is not used yet. It is a proof of concept.
export type Parts = {
  type: "parts";
  kind: "parts";
  parts: Part[];
  artifacts?: Part[];
};

/**
 * WhatsApp Messages
 * Text (caption for media types)
 * Media (File)
 * Data
 *
 * Text and/or Media (up to two parts), or Data (one part)
 *
 * Excepting Reaction, Contacts and Location, all other types differ depending on the direction (incoming or outgoing)
 */

export type IncomingMessage =
  & {
    version: "1";
    re_message_id?: string; // replied, reacted or forwarded message id
    forwarded?: boolean;
    referred_product?: {
      catalog_id: string;
      product_retailer_id: string;
    };
  }
  & ReferralInfo
  & TaskInfo
  & (
    | TextPart
    | FilePart
    | ContactsPart
    | LocationPart
    | OrderPart
    | InteractivePart
    | ButtonPart
    | MediaPlaceholderPart
    | UnsupportedPart
  );

export type InternalMessage =
  & {
    version: "1";
    re_message_id?: string; // replied, reacted or forwarded message id
    forwarded?: boolean;
  }
  & TaskInfo
  & ToolInfo
  & Part;

export type OutgoingMessage =
  & {
    version: "1";
    re_message_id?: string; // replied, reacted or forwarded message id
    forwarded?: boolean;
  }
  & TaskInfo
  & (TextPart | FilePart | ContactsPart | LocationPart | TemplatePart);
