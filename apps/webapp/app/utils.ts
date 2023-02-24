import type { RouteMatch } from "@remix-run/react";
import { useMatches } from "@remix-run/react";
import { DEV_ENVIRONMENT } from "./consts";

const DEFAULT_REDIRECT = "/";

/**
 * This should be used any time the redirect path is user-provided
 * (Like the query string on our login/signup pages). This avoids
 * open-redirect vulnerabilities.
 * @param {string} to The redirect destination
 * @param {string} defaultRedirect The redirect to use if the to is unsafe.
 */
export function safeRedirect(
  to: FormDataEntryValue | string | null | undefined,
  defaultRedirect: string = DEFAULT_REDIRECT
) {
  if (!to || typeof to !== "string") {
    return defaultRedirect;
  }

  if (!to.startsWith("/") || to.startsWith("//")) {
    return defaultRedirect;
  }

  return to;
}

/**
 * This base hook is used in other hooks to quickly search for specific data
 * across all loader data using useMatches.
 * @param {string} id The route id
 * @returns {JSON|undefined} The router data or undefined if not found
 */
export function useMatchesData(
  id: string | string[],
  debug: boolean = false
): RouteMatch | undefined {
  const matchingRoutes = useMatches();

  if (debug) {
    console.log("matchingRoutes", matchingRoutes);
  }

  const paths = Array.isArray(id) ? id : [id];

  // Get the first matching route
  const route = paths.reduce((acc, path) => {
    if (acc) return acc;
    return matchingRoutes.find((route) => route.id === path);
  }, undefined as RouteMatch | undefined);

  return route;
}

export function validateEmail(email: unknown): email is string {
  return typeof email === "string" && email.length > 3 && email.includes("@");
}

export function hydrateObject<T>(object: any): T {
  return hydrateDates(object) as T;
}

export function hydrateDates(object: any): any {
  if (object === null || object === undefined) {
    return object;
  }

  if (object instanceof Date) {
    return object;
  }

  if (typeof object === "string" && object.match(/\d{4}-\d{2}-\d{2}/)) {
    return new Date(object);
  }

  if (typeof object === "object") {
    if (Array.isArray(object)) {
      return object.map((item) => hydrateDates(item));
    } else {
      const hydratedObject: any = {};
      for (const key in object) {
        hydratedObject[key] = hydrateDates(object[key]);
      }
      return hydratedObject;
    }
  }

  return object;
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});
const dateFormatterLong = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "medium",
});

export function formatDateTime(
  date: Date,
  style: "medium" | "long" = "medium"
): string {
  try {
    switch (style) {
      case "long":
        return dateFormatterLong.format(date);
      case "medium":
        return dateFormatter.format(date);
    }
  } catch (error) {
    console.error(error);
    return "Unknown";
  }
}

export type PrismaReturnType<T extends (...args: any) => any> = Awaited<
  ReturnType<T>
>;

export function titleCase(original: string): string {
  return original
    .split(" ")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

export function dateDifference(date1: Date, date2: Date) {
  return Math.abs(date1.getTime() - date2.getTime());
}

export const environmentShortName = (slug: string) =>
  slug === DEV_ENVIRONMENT ? "Dev" : "Live";

// Takes an api key (either trigger_live_xxxx or trigger_development_xxxx) and returns trigger_live_********
export const obfuscateApiKey = (apiKey: string) => {
  const [prefix, slug, secretPart] = apiKey.split("_");
  return `${prefix}_${slug}_${"*".repeat(secretPart.length)}`;
};
