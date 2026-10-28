export const IOS_PROJECT = `// !$*UTF8*$!
{
  archiveVersion = 1;
  classes = {};
  objectVersion = 56;
  objects = {

/* Begin PBXBuildFile section */
    000000000000000000000030 = {isa = PBXBuildFile; fileRef = 000000000000000000000010; };
    000000000000000000000031 = {isa = PBXBuildFile; fileRef = 000000000000000000000011; };
    000000000000000000000032 = {isa = PBXBuildFile; fileRef = 000000000000000000000012; };
    000000000000000000000033 = {isa = PBXBuildFile; fileRef = 000000000000000000000013; };
/* End PBXBuildFile section */

/* Begin PBXContainerItemProxy section */
    000000000000000000000061 = {isa = PBXContainerItemProxy; containerPortal = 000000000000000000000001; proxyType = 1; remoteGlobalIDString = 000000000000000000000050; remoteInfo = HarnessIOS; };
    000000000000000000000063 = {isa = PBXContainerItemProxy; containerPortal = 000000000000000000000001; proxyType = 1; remoteGlobalIDString = 000000000000000000000050; remoteInfo = HarnessIOS; };
/* End PBXContainerItemProxy section */

/* Begin PBXFileReference section */
    000000000000000000000010 = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = HarnessIOSApp.swift; sourceTree = "<group>"; };
    000000000000000000000011 = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = LaunchView.swift; sourceTree = "<group>"; };
    000000000000000000000012 = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = LaunchViewTests.swift; sourceTree = "<group>"; };
    000000000000000000000013 = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = HarnessIOSUITests.swift; sourceTree = "<group>"; };
    000000000000000000000020 = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = HarnessIOS.app; sourceTree = BUILT_PRODUCTS_DIR; };
    000000000000000000000021 = {isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = HarnessIOSTests.xctest; sourceTree = BUILT_PRODUCTS_DIR; };
    000000000000000000000022 = {isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = HarnessIOSUITests.xctest; sourceTree = BUILT_PRODUCTS_DIR; };
/* End PBXFileReference section */

/* Begin PBXFrameworksBuildPhase section */
    000000000000000000000041 = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
    000000000000000000000044 = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
    000000000000000000000047 = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
    000000000000000000000002 = {isa = PBXGroup; children = (000000000000000000000004, 000000000000000000000005, 000000000000000000000006, 000000000000000000000003); sourceTree = "<group>"; };
    000000000000000000000003 = {isa = PBXGroup; children = (000000000000000000000020, 000000000000000000000021, 000000000000000000000022); name = Products; sourceTree = "<group>"; };
    000000000000000000000004 = {isa = PBXGroup; children = (000000000000000000000010, 000000000000000000000011); path = HarnessIOS; sourceTree = "<group>"; };
    000000000000000000000005 = {isa = PBXGroup; children = (000000000000000000000012); path = Tests; sourceTree = "<group>"; };
    000000000000000000000006 = {isa = PBXGroup; children = (000000000000000000000013); path = UITests; sourceTree = "<group>"; };
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
    000000000000000000000050 = {isa = PBXNativeTarget; buildConfigurationList = 000000000000000000000081; buildPhases = (000000000000000000000040, 000000000000000000000041, 000000000000000000000042); buildRules = (); dependencies = (); name = HarnessIOS; productName = HarnessIOS; productReference = 000000000000000000000020; productType = "com.apple.product-type.application"; };
    000000000000000000000051 = {isa = PBXNativeTarget; buildConfigurationList = 000000000000000000000082; buildPhases = (000000000000000000000043, 000000000000000000000044, 000000000000000000000045); buildRules = (); dependencies = (000000000000000000000060); name = HarnessIOSTests; productName = HarnessIOSTests; productReference = 000000000000000000000021; productType = "com.apple.product-type.bundle.unit-test"; };
    000000000000000000000052 = {isa = PBXNativeTarget; buildConfigurationList = 000000000000000000000083; buildPhases = (000000000000000000000046, 000000000000000000000047, 000000000000000000000048); buildRules = (); dependencies = (000000000000000000000062); name = HarnessIOSUITests; productName = HarnessIOSUITests; productReference = 000000000000000000000022; productType = "com.apple.product-type.bundle.ui-testing"; };
/* End PBXNativeTarget section */

/* Begin PBXProject section */
    000000000000000000000001 = {isa = PBXProject; attributes = {BuildIndependentTargetsInParallel = 1; LastSwiftUpdateCheck = 2660; TargetAttributes = {000000000000000000000050 = {CreatedOnToolsVersion = 26.6; }; 000000000000000000000051 = {CreatedOnToolsVersion = 26.6; TestTargetID = 000000000000000000000050; }; 000000000000000000000052 = {CreatedOnToolsVersion = 26.6; TestTargetID = 000000000000000000000050; }; }; }; buildConfigurationList = 000000000000000000000080; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en, Base); mainGroup = 000000000000000000000002; productRefGroup = 000000000000000000000003; projectDirPath = ""; projectRoot = ""; targets = (000000000000000000000050, 000000000000000000000051, 000000000000000000000052); };
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
    000000000000000000000042 = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
    000000000000000000000045 = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
    000000000000000000000048 = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
    000000000000000000000040 = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (000000000000000000000030, 000000000000000000000031); runOnlyForDeploymentPostprocessing = 0; };
    000000000000000000000043 = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (000000000000000000000032); runOnlyForDeploymentPostprocessing = 0; };
    000000000000000000000046 = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (000000000000000000000033); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXSourcesBuildPhase section */

/* Begin PBXTargetDependency section */
    000000000000000000000060 = {isa = PBXTargetDependency; target = 000000000000000000000050; targetProxy = 000000000000000000000061; };
    000000000000000000000062 = {isa = PBXTargetDependency; target = 000000000000000000000050; targetProxy = 000000000000000000000063; };
/* End PBXTargetDependency section */

/* Begin XCBuildConfiguration section */
    000000000000000000000070 = {isa = XCBuildConfiguration; buildSettings = {ALWAYS_SEARCH_USER_PATHS = NO; CLANG_ENABLE_MODULES = YES; IPHONEOS_DEPLOYMENT_TARGET = 17.0; SDKROOT = iphoneos; SWIFT_OPTIMIZATION_LEVEL = "-Onone"; SWIFT_VERSION = 6.0; }; name = Debug; };
    000000000000000000000071 = {isa = XCBuildConfiguration; buildSettings = {ALWAYS_SEARCH_USER_PATHS = NO; CLANG_ENABLE_MODULES = YES; IPHONEOS_DEPLOYMENT_TARGET = 17.0; SDKROOT = iphoneos; SWIFT_COMPILATION_MODE = wholemodule; SWIFT_VERSION = 6.0; }; name = Release; };
    000000000000000000000072 = {isa = XCBuildConfiguration; buildSettings = {CODE_SIGN_STYLE = Automatic; CURRENT_PROJECT_VERSION = 1; ENABLE_TESTABILITY = YES; GENERATE_INFOPLIST_FILE = YES; INFOPLIST_KEY_UILaunchScreen_Generation = YES; MARKETING_VERSION = 1.0; PRODUCT_BUNDLE_IDENTIFIER = com.example.harness.ios; PRODUCT_NAME = "$(TARGET_NAME)"; TARGETED_DEVICE_FAMILY = "1,2"; }; name = Debug; };
    000000000000000000000073 = {isa = XCBuildConfiguration; buildSettings = {CODE_SIGN_STYLE = Automatic; CURRENT_PROJECT_VERSION = 1; GENERATE_INFOPLIST_FILE = YES; INFOPLIST_KEY_UILaunchScreen_Generation = YES; MARKETING_VERSION = 1.0; PRODUCT_BUNDLE_IDENTIFIER = com.example.harness.ios; PRODUCT_NAME = "$(TARGET_NAME)"; TARGETED_DEVICE_FAMILY = "1,2"; }; name = Release; };
    000000000000000000000074 = {isa = XCBuildConfiguration; buildSettings = {BUNDLE_LOADER = "$(TEST_HOST)"; CODE_SIGN_STYLE = Automatic; GENERATE_INFOPLIST_FILE = YES; PRODUCT_BUNDLE_IDENTIFIER = com.example.harness.ios.tests; PRODUCT_NAME = "$(TARGET_NAME)"; TEST_HOST = "$(BUILT_PRODUCTS_DIR)/HarnessIOS.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/HarnessIOS"; }; name = Debug; };
    000000000000000000000075 = {isa = XCBuildConfiguration; buildSettings = {BUNDLE_LOADER = "$(TEST_HOST)"; CODE_SIGN_STYLE = Automatic; GENERATE_INFOPLIST_FILE = YES; PRODUCT_BUNDLE_IDENTIFIER = com.example.harness.ios.tests; PRODUCT_NAME = "$(TARGET_NAME)"; TEST_HOST = "$(BUILT_PRODUCTS_DIR)/HarnessIOS.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/HarnessIOS"; }; name = Release; };
    000000000000000000000076 = {isa = XCBuildConfiguration; buildSettings = {CODE_SIGN_STYLE = Automatic; GENERATE_INFOPLIST_FILE = YES; PRODUCT_BUNDLE_IDENTIFIER = com.example.harness.ios.uitests; PRODUCT_NAME = "$(TARGET_NAME)"; TEST_TARGET_NAME = HarnessIOS; }; name = Debug; };
    000000000000000000000077 = {isa = XCBuildConfiguration; buildSettings = {CODE_SIGN_STYLE = Automatic; GENERATE_INFOPLIST_FILE = YES; PRODUCT_BUNDLE_IDENTIFIER = com.example.harness.ios.uitests; PRODUCT_NAME = "$(TARGET_NAME)"; TEST_TARGET_NAME = HarnessIOS; }; name = Release; };
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
    000000000000000000000080 = {isa = XCConfigurationList; buildConfigurations = (000000000000000000000070, 000000000000000000000071); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
    000000000000000000000081 = {isa = XCConfigurationList; buildConfigurations = (000000000000000000000072, 000000000000000000000073); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
    000000000000000000000082 = {isa = XCConfigurationList; buildConfigurations = (000000000000000000000074, 000000000000000000000075); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
    000000000000000000000083 = {isa = XCConfigurationList; buildConfigurations = (000000000000000000000076, 000000000000000000000077); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
/* End XCConfigurationList section */
  };
  rootObject = 000000000000000000000001;
}
`
