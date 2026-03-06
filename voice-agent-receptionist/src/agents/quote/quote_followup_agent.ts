import { QuoteService } from "../../services/quote";
import { SimulatedSmsTool } from "../../tools/sms";
import { AgentDescriptor } from "../contracts";

export interface BookingTextArgs {
  sessionId?: number;
  name: string;
  phone: string;
  issue: string;
  urgency: string;
  windowLabel: string;
}

export class QuoteFollowupAgent {
  readonly descriptor: AgentDescriptor = {
    id: "quote_followup",
    name: "Quote Follow-up Agent",
    purpose: "Owns post-booking confirmation and quote messaging.",
    owns: ["confirmation_sms", "quote_sms", "reschedule_sms", "cancel_sms"]
  };

  constructor(
    private readonly sms: SimulatedSmsTool,
    private readonly quoteService: QuoteService
  ) {}

  sendBookingTexts(args: BookingTextArgs): { confirmation_sms_id: number; quote_sms_id: number } {
    const confirmation = this.sms.sendSms(
      {
        to: args.phone,
        message: `Confirmed: Plumbing appointment scheduled for ${args.windowLabel}. Reply RESCHEDULE if you need to change it.`
      },
      args.sessionId
    );

    const quote = this.quoteService.createQuote(args.issue, args.urgency);
    const quoteSms = this.sms.sendSms(
      {
        to: args.phone,
        message: this.quoteService.buildQuoteSms(args.name, quote)
      },
      args.sessionId
    );

    return {
      confirmation_sms_id: confirmation.sms_id,
      quote_sms_id: quoteSms.sms_id
    };
  }

  sendCancellationText(sessionId: number | undefined, phone: string): { cancellation_sms_id: number } {
    const sms = this.sms.sendSms(
      {
        to: phone,
        message: "Your plumbing appointment has been cancelled. Reply anytime to schedule a new window."
      },
      sessionId
    );

    return {
      cancellation_sms_id: sms.sms_id
    };
  }

  sendRescheduleText(sessionId: number | undefined, phone: string, windowLabel: string): { reschedule_sms_id: number } {
    const sms = this.sms.sendSms(
      {
        to: phone,
        message: `Your plumbing appointment is now set for ${windowLabel}.`
      },
      sessionId
    );

    return {
      reschedule_sms_id: sms.sms_id
    };
  }
}

