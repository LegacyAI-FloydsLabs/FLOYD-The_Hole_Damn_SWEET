#import <Foundation/Foundation.h>
#import <Security/Security.h>

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSString *account = argc > 1
      ? [NSString stringWithUTF8String:argv[1]]
      : @"provider-credentials";
    const char *service = "space.legacyai.floyd.vault";
    const char *accountBytes = account.UTF8String;
    UInt32 resultLength = 0;
    void *result = NULL;
    SecKeychainSetUserInteractionAllowed(false);
    OSStatus status = SecKeychainFindGenericPassword(
      NULL,
      (UInt32)strlen(service),
      service,
      (UInt32)strlen(accountBytes),
      accountBytes,
      &resultLength,
      &result,
      NULL
    );
    if (result) SecKeychainItemFreeContent(NULL, result);
    if (status == errSecSuccess) {
      fputs("KEYCHAIN_ISOLATION FAIL untrusted probe read the item without authorization\n", stderr);
      return 1;
    }
    if (status == errSecInteractionNotAllowed || status == errSecItemNotFound
        || status == errSecMissingEntitlement || status == errSecAuthFailed) {
      printf("KEYCHAIN_ISOLATION PASS status=%d silent_read=denied\n", (int)status);
      return 0;
    }
    fprintf(stderr, "KEYCHAIN_ISOLATION FAIL unexpected_status=%d\n", (int)status);
    return 2;
  }
}
