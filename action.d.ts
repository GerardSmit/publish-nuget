declare global {
    namespace NodeJS {
        interface ProcessEnv {
            VERSION_REGEX: string;
            TAG_COMMIT: string;
            TAG_FORMAT: string;
            NUGET_SOURCE: string;
            INCLUDE_SYMBOLS: string;
            NO_BUILD: string;
            INPUT_PROJECT_FILE_PATH: string;
        }
    }
}

export { };