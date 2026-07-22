/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as attendance from "../attendance.js";
import type * as beltTaxonomy from "../beltTaxonomy.js";
import type * as classes from "../classes.js";
import type * as crons from "../crons.js";
import type * as enrollments from "../enrollments.js";
import type * as gyms from "../gyms.js";
import type * as http from "../http.js";
import type * as invoices from "../invoices.js";
import type * as members from "../members.js";
import type * as migrations from "../migrations.js";
import type * as promotionCriteria from "../promotionCriteria.js";
import type * as rateLimit from "../rateLimit.js";
import type * as recoveryAction from "../recoveryAction.js";
import type * as sendRetentionTexts from "../sendRetentionTexts.js";
import type * as stripeWebhookAction from "../stripeWebhookAction.js";
import type * as subscriptions from "../subscriptions.js";
import type * as twilioWebhookAction from "../twilioWebhookAction.js";
import type * as validate from "../validate.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  attendance: typeof attendance;
  beltTaxonomy: typeof beltTaxonomy;
  classes: typeof classes;
  crons: typeof crons;
  enrollments: typeof enrollments;
  gyms: typeof gyms;
  http: typeof http;
  invoices: typeof invoices;
  members: typeof members;
  migrations: typeof migrations;
  promotionCriteria: typeof promotionCriteria;
  rateLimit: typeof rateLimit;
  recoveryAction: typeof recoveryAction;
  sendRetentionTexts: typeof sendRetentionTexts;
  stripeWebhookAction: typeof stripeWebhookAction;
  subscriptions: typeof subscriptions;
  twilioWebhookAction: typeof twilioWebhookAction;
  validate: typeof validate;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
