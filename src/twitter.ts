import Twitter from "twitter-lite";

/**
 * Small helper to get the twitter-lite client into typescript
 *
 * @see https://github.com/draftbit/twitter-lite/pull/88
 * @param subdomain which subdomain this client is for
 * @returns the instantiated twitter lite client
 */
export const getTwitterClient = (
  subdomain: string = "api",
): Twitter.Twitter => {
  /* eslint-disable @typescript-eslint/ban-ts-ignore */
  // @ts-ignore https://github.com/draftbit/twitter-lite/pull/88
  return new Twitter({
    /* eslint-disable @typescript-eslint/camelcase */
    subdomain,
    consumer_key: process.env.CONSUMER_KEY,
    consumer_secret: process.env.CONSUMER_SECRET,
    access_token_key: process.env.ACCESS_TOKEN_KEY,
    access_token_secret: process.env.ACCESS_TOKEN_SECRET,
    /* eslint-enable @typescript-eslint/camelcase */
  });
  /* eslint-enable @typescript-eslint/ban-ts-ignore */
};

console.log("wtf", process.env.CONSUMER_KEY);
