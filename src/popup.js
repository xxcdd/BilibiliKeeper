document.addEventListener('DOMContentLoaded', function() {
  // 加载已保存的API设置、兴趣主题和其他设置
  chrome.storage.sync.get(['api_key', 'api_url', 'interests', 'isRunning', 'batchSize'], function(result) {
    // 设置API密钥和URL
    if (result.api_key) {
      document.getElementById('api_key').value = result.api_key;
    }
    
    if (result.api_url) {
      document.getElementById('api_url').value = result.api_url;
    }
    
    // 设置兴趣主题标签
    if (result.interests) {
      // 如果是旧版格式（文本域格式），转换为数组
      let tagsArray = [];
      if (typeof result.interests === 'string') {
        tagsArray = result.interests.split('\n')
          .map(tag => tag.trim())
          .filter(tag => tag.length > 0);
      } else if (Array.isArray(result.interests)) {
        tagsArray = result.interests;
      }
      
      // 渲染标签
      renderTags(tagsArray);
    }
    
    // 显示当前运行状态
    updateRunningStatus(result.isRunning || false);
    
    // 更新批量处理大小
    if (result.batchSize) {
      document.getElementById('batchSize').value = result.batchSize;
    }
    
    // 如果正在运行，加载统计数据
    if (result.isRunning) {
      loadFilterStats();
    }
  });

  // 保存API设置按钮点击事件
  document.getElementById('saveApi').addEventListener('click', function() {
    const apiKey = document.getElementById('api_key').value.trim();
    const apiUrl = document.getElementById('api_url').value.trim();
    
    if (!apiKey || !apiUrl) {
      showStatus('请输入API密钥和API地址', false);
      return;
    }
    
    chrome.storage.sync.set({
      api_key: apiKey,
      api_url: apiUrl
    }, function() {
      showStatus('API设置已保存', true);
      
      // 通知内容脚本更新API设置
      chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        if (tabs[0] && tabs[0].url.includes('bilibili.com')) {
          chrome.tabs.sendMessage(tabs[0].id, { 
            action: 'setAPISettings',
            api_key: apiKey,
            api_url: apiUrl
          });
        }
      });
    });
  });

  // 添加标签按钮点击事件
  document.getElementById('add-tag').addEventListener('click', function() {
    addTag();
  });
  
  // 标签输入框回车事件
  document.getElementById('tag-input').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
      addTag();
    }
  });
  
  // 保存标签设置按钮点击事件
  document.getElementById('save').addEventListener('click', function() {
    saveTags();
  });
  
  // 保存批量处理大小按钮
  document.getElementById('saveBatchSize').addEventListener('click', function() {
    const batchSizeElem = document.getElementById('batchSize');
    const batchSize = parseInt(batchSizeElem.value);
    
    if (isNaN(batchSize) || batchSize < 2 || batchSize > 10) {
      showStatus('批量处理大小必须在2到10之间', false);
      return;
    }
    
    chrome.storage.sync.set({
      batchSize: batchSize
    }, function() {
      showStatus('批量处理大小已保存', true);
      
      // 如果正在运行，更新当前运行的设置
      chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        if (tabs[0] && tabs[0].url.includes('bilibili.com')) {
          chrome.tabs.sendMessage(tabs[0].id, { 
            action: 'setBatchSize',
            batchSize: batchSize
          });
        }
      });
    });
  });
  
  // 开始过滤按钮点击事件
  document.getElementById('start').addEventListener('click', function() {
    // 获取当前标签
    const tags = Array.from(document.querySelectorAll('.tag span'))
      .map(span => span.textContent);
    
    if (tags.length === 0) {
      showStatus('请先设置感兴趣的主题', false);
      return;
    }
    
    const apiKey = document.getElementById('api_key').value.trim();
    const apiUrl = document.getElementById('api_url').value.trim();
    
    if (!apiKey || !apiUrl) {
      showStatus('请先设置API密钥和API地址', false);
      return;
    }
    
    chrome.storage.sync.set({ 
      isRunning: true,
      interests: tags // 保存最新的标签
    }, function() {
      updateRunningStatus(true);
      showStatus('过滤已开始', true);
      
      // 重置统计数据
      chrome.storage.local.set({
        totalProcessed: 0,
        totalFiltered: 0
      });
      
      // 添加统计显示
      addStatsDisplay();
      
      // 通知内容脚本开始过滤
      chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        if (tabs[0] && tabs[0].url.includes('bilibili.com')) {
          chrome.tabs.sendMessage(tabs[0].id, { action: 'start' });
        } else {
          showStatus('请在哔哩哔哩网站上使用此功能', false);
        }
      });
    });
  });
  
  // 停止过滤按钮点击事件
  document.getElementById('stop').addEventListener('click', function() {
    chrome.storage.sync.set({ isRunning: false }, function() {
      updateRunningStatus(false);
      showStatus('过滤已停止', true);
      
      // 通知内容脚本停止过滤
      chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        if (tabs[0] && tabs[0].url.includes('bilibili.com')) {
          chrome.tabs.sendMessage(tabs[0].id, { action: 'stop' });
        }
      });
    });
  });
  
  // 定期更新统计数据
  setInterval(loadFilterStats, 2000);
});

function showStatus(message, isSuccess) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = 'status ' + (isSuccess ? 'success' : 'error');
}

function updateRunningStatus(isRunning) {
  const runningStatus = document.getElementById('running-status');
  if (isRunning) {
    runningStatus.textContent = '当前状态: 正在过滤';
    runningStatus.style.color = '#1565c0';
    loadFilterStats(); // 立即加载统计数据
  } else {
    runningStatus.textContent = '当前状态: 未运行';
    runningStatus.style.color = '#757575';
    removeStatsDisplay(); // 移除统计显示
  }
}

// 加载过滤统计数据
function loadFilterStats() {
  chrome.storage.local.get(['totalProcessed', 'totalFiltered'], function(result) {
    updateStatsDisplay(result.totalProcessed || 0, result.totalFiltered || 0);
  });
}

// 添加统计显示
function addStatsDisplay() {
  // 检查是否已存在
  if (document.getElementById('stats-display')) {
    return;
  }
  
  const container = document.querySelector('.container');
  
  // 创建统计显示区域
  const statsDiv = document.createElement('div');
  statsDiv.id = 'stats-display';
  statsDiv.className = 'section-title';
  statsDiv.textContent = '过滤统计';
  
  const statsContent = document.createElement('div');
  statsContent.id = 'stats-content';
  statsContent.style.padding = '5px';
  statsContent.style.backgroundColor = '#f5f5f5';
  statsContent.style.borderRadius = '4px';
  statsContent.style.marginBottom = '10px';
  
  // 初始化统计内容
  statsContent.innerHTML = '已处理: 0 个视频 | 已过滤: 0 个视频';
  
  // 添加到容器
  container.insertBefore(statsDiv, document.getElementById('status'));
  container.insertBefore(statsContent, document.getElementById('status'));
}

// 更新统计显示
function updateStatsDisplay(processed, filtered) {
  const statsContent = document.getElementById('stats-content');
  if (statsContent) {
    statsContent.innerHTML = `已处理: ${processed} 个视频 | 已过滤: ${filtered} 个视频`;
  } else {
    // 如果不存在且应该显示，则添加
    if (processed > 0 || filtered > 0) {
      addStatsDisplay();
      updateStatsDisplay(processed, filtered);
    }
  }
}

// 移除统计显示
function removeStatsDisplay() {
  const statsDiv = document.getElementById('stats-display');
  const statsContent = document.getElementById('stats-content');
  
  if (statsDiv) {
    statsDiv.remove();
  }
  
  if (statsContent) {
    statsContent.remove();
  }
}

// 监听消息
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.action === 'start') {
    // 检查API设置是否有效
    if (!API_KEY || !API_URL) {
      showNotification('请在设置中配置API密钥和API地址，过滤无法启动', 'error');
      sendResponse({status: 'error', message: 'API settings not configured'});
      return true;
    }
    
    // ... existing code ...
  } else if (request.action === 'stop') {
    // ... existing code ...
  } else if (request.action === 'setBatchSize') {
    // ... existing code ...
  } else if (request.action === 'setAPISettings') {
    // ... existing code ...
  }
  
  sendResponse({status: 'success'});
  return true; // Keep the message channel open for async responses
});

// 渲染标签
function renderTags(tagsArray) {
  const tagsContainer = document.getElementById('tags-container');
  tagsContainer.innerHTML = ''; // 清空容器
  
  tagsArray.forEach(tag => {
    const tagElement = document.createElement('div');
    tagElement.className = 'tag';
    
    const tagText = document.createElement('span');
    tagText.textContent = tag;
    
    const deleteButton = document.createElement('button');
    deleteButton.className = 'tag-delete';
    deleteButton.textContent = '×';
    deleteButton.addEventListener('click', function() {
      tagElement.remove();
    });
    
    tagElement.appendChild(tagText);
    tagElement.appendChild(deleteButton);
    tagsContainer.appendChild(tagElement);
  });
}

// 添加标签
function addTag() {
  const tagInput = document.getElementById('tag-input');
  const tagText = tagInput.value.trim();
  
  if (!tagText) {
    return;
  }
  
  // 检查标签是否已存在
  const existingTags = Array.from(document.querySelectorAll('.tag span'))
    .map(span => span.textContent);
    
  if (existingTags.includes(tagText)) {
    showStatus('该标签已存在', false);
    return;
  }
  
  const tagsContainer = document.getElementById('tags-container');
  
  const tagElement = document.createElement('div');
  tagElement.className = 'tag';
  
  const tagTextSpan = document.createElement('span');
  tagTextSpan.textContent = tagText;
  
  const deleteButton = document.createElement('button');
  deleteButton.className = 'tag-delete';
  deleteButton.textContent = '×';
  deleteButton.addEventListener('click', function() {
    tagElement.remove();
  });
  
  tagElement.appendChild(tagTextSpan);
  tagElement.appendChild(deleteButton);
  tagsContainer.appendChild(tagElement);
  
  // 清空输入框
  tagInput.value = '';
  tagInput.focus();
}

// 保存标签
function saveTags() {
  const tags = Array.from(document.querySelectorAll('.tag span'))
    .map(span => span.textContent);
  
  if (tags.length === 0) {
    showStatus('请添加至少一个感兴趣的主题', false);
    return;
  }
  
  chrome.storage.sync.set({
    interests: tags
  }, function() {
    showStatus('标签设置已保存', true);
  });
} 