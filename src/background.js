// 监听扩展安装或更新事件
chrome.runtime.onInstalled.addListener(function() {
  // 初始化存储的设置
  chrome.storage.sync.get(['interests', 'isRunning', 'batchSize'], function(result) {
    // 如果没有设置兴趣主题，设置一个空字符串
    if (!result.interests) {
      chrome.storage.sync.set({ interests: '' });
    }
    
    // 如果没有设置运行状态，默认为未运行
    if (result.isRunning === undefined) {
      chrome.storage.sync.set({ isRunning: false });
    }
    
    // 如果没有设置批处理大小，设置默认值5
    if (!result.batchSize) {
      chrome.storage.sync.set({ batchSize: 5 });
    }
  });
});

// 监听来自content script的消息
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  // 显示系统通知
  if (request.action === 'showNotification') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'images/icon128.png',
      title: request.title || 'Bilibili Content Filter',
      message: request.message,
      priority: 2
    });
    
    sendResponse({status: 'success'});
  }
  
  // 记录过滤统计数据
  if (request.action === 'updateStats') {
    chrome.storage.local.set({
      totalProcessed: request.totalProcessed,
      totalFiltered: request.totalFiltered
    });
    
    sendResponse({status: 'success'});
  }
  
  // 返回true以保持消息端口开放，用于异步响应
  return true;
});

// 当用户点击扩展图标时
chrome.action.onClicked.addListener(function(tab) {
  // 如果不在B站页面上，显示通知
  if (!tab.url.includes('bilibili.com')) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'images/icon128.png',
      title: 'Bilibili Content Filter',
      message: '请在哔哩哔哩网站上使用此功能',
      priority: 2
    });
  }
}); 