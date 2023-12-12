/*
  Direct usage of .env file would be preferred but
  due to issue with Parcel CLI build which does not include/load the environment variables
  I decided to use this way and have a simple way to define config.
*/

export const RPCH_SECRET_TOKEN = process.env.RPCH_SECRET_TOKEN || 'SECRET KEY' // TEST VALUE

export const DISCOVERY_PLATFORM_API_ENDPOINT =
  process.env.DISCOVERY_PLATFORM_API_ENDPOINT || 'https://discovery.rpch.tech'
